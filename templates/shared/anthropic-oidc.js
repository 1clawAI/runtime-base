"use strict";
/**
 * Anthropic Workload Identity Federation, from inside a runtime.
 *
 * Two exchanges, documented in docs/agents/oidc-federation.md:
 *
 *   POST {vault}/v1/auth/federated-token   audience=https://api.anthropic.com
 *     → a 1claw-signed RS256 JWT, verified by Anthropic against our JWKS
 *   POST https://api.anthropic.com/v1/oauth/token
 *     grant_type=jwt-bearer, assertion=<that JWT>
 *     → sk-ant-oat01-…
 *
 * The result is used as `ANTHROPIC_API_KEY`. The point of the whole exercise
 * is that no Anthropic key is stored anywhere — not in env_public, not in a
 * vault secret, not on disk. The runtime mints a short-lived one and mints
 * another before it lapses.
 *
 * Which puts the weight on the refresh: there is no static credential to fall
 * back on, so a refresh that is late is an outage. Same 70%-of-remaining rule
 * as the agent-token renewal, for the same reason — a failure leaves room for
 * several more attempts before anything actually stops working.
 *
 * This covers the *direct* path. When the agent has `shroud_enabled`, LLM
 * traffic goes through the sidecar to Shroud, which holds the provider
 * credential itself; federation there would be Shroud's exchange to make, not
 * this one.
 */

const { getAgentToken, apiAuthHeaders, vaultBaseUrl } = require("./agent-token.js");

const ANTHROPIC_AUDIENCE = "https://api.anthropic.com";
const ANTHROPIC_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

const MIN_REFRESH_MS = 30_000;
const MAX_REFRESH_MS = 30 * 60_000;
const RETRY_REFRESH_MS = 60_000;

/**
 * When to mint the next one, in milliseconds.
 *
 * Floors and ceilings keep a nonsense `expires_in` from producing either a
 * busy loop or a wait longer than the credential it is protecting.
 */
function nextAnthropicRefreshMs(expMs, now = Date.now()) {
  if (!expMs || !Number.isFinite(expMs)) return MAX_REFRESH_MS;
  const remaining = expMs - now;
  if (remaining <= 0) return MIN_REFRESH_MS;
  return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, Math.floor(remaining * 0.7)));
}

function buildAssertionForm(jwt) {
  const body = new URLSearchParams();
  body.set("grant_type", JWT_BEARER_GRANT);
  body.set("assertion", jwt);
  // URLSearchParams percent-encodes `.` nowhere and `:` in the grant, which
  // is what Anthropic's documented form looks like.
  return body.toString();
}

/**
 * A failure message safe to log and safe to paste into a ticket.
 *
 * Both halves of this exchange are credentials: the assertion is a signed
 * identity and the response carries an Anthropic token. An error body is the
 * most likely place for one to escape, because it is the thing people copy.
 * So the body is never quoted — only its status, and a pointer at the step
 * that is usually the actual problem.
 */
function describeExchangeFailure(status, _body) {
  const hint =
    status === 401 || status === 403
      ? " Anthropic rejected the assertion — usually the 1claw provider is not registered " +
        "in the Anthropic Console yet, or the allowed audience there does not match " +
        `${ANTHROPIC_AUDIENCE}. Check Workload Identity Federation → providers.`
      : status === 400
        ? " Anthropic could not read the assertion. Check that federation is enabled on " +
          "the agent and that its allowed-audience list contains " +
          `${ANTHROPIC_AUDIENCE}.`
        : "";
  // Deliberately no body: see above.
  return `Anthropic token exchange failed with HTTP ${status}.${hint}`;
}

/** Mint the 1claw-signed assertion. */
async function fetchFederatedJwt(audience = ANTHROPIC_AUDIENCE) {
  const token = getAgentToken();
  if (!token) throw new Error("no agent credential available to exchange");
  const resp = await fetch(`${vaultBaseUrl()}/v1/auth/federated-token`, {
    method: "POST",
    headers: { ...apiAuthHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ audience }),
  });
  if (!resp.ok) {
    // This half is ours, so the status is enough to find it in our own logs.
    throw new Error(`federated-token request failed with HTTP ${resp.status}`);
  }
  const json = await resp.json();
  if (!json || typeof json.access_token !== "string" || !json.access_token) {
    throw new Error("federated-token response carried no access_token");
  }
  return json.access_token;
}

/** Trade the assertion for an Anthropic token. */
async function exchangeAtAnthropic(jwt) {
  const resp = await fetch(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: buildAssertionForm(jwt),
  });
  const body = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(describeExchangeFailure(resp.status, body));
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error("Anthropic token exchange returned a body that is not JSON");
  }
  if (!json || typeof json.access_token !== "string" || !json.access_token) {
    throw new Error("Anthropic token exchange returned no access_token");
  }
  const expiresInMs = Number(json.expires_in) > 0 ? Number(json.expires_in) * 1000 : null;
  return { token: json.access_token, expMs: expiresInMs ? Date.now() + expiresInMs : null };
}

let current = null;

async function getAnthropicToken() {
  if (current && current.expMs && Date.now() < current.expMs - MIN_REFRESH_MS) {
    return current.token;
  }
  const jwt = await fetchFederatedJwt();
  current = await exchangeAtAnthropic(jwt);
  return current.token;
}

/**
 * Keep `ANTHROPIC_API_KEY` current for anything in this process that reads it
 * at call time. Returns a stop function.
 */
function startAnthropicOidcRefresh({ onToken } = {}) {
  let timer = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    let delay = RETRY_REFRESH_MS;
    try {
      const token = await getAnthropicToken();
      process.env.ANTHROPIC_API_KEY = token;
      if (typeof onToken === "function") onToken(token);
      delay = nextAnthropicRefreshMs(current && current.expMs);
      console.log("[anthropic-oidc] minted a federated Anthropic token");
    } catch (err) {
      // The message is already body-free; see describeExchangeFailure.
      console.warn(`[anthropic-oidc] ${err.message} — retrying`);
    }
    if (!stopped) timer = setTimeout(tick, delay);
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

module.exports = {
  ANTHROPIC_AUDIENCE,
  ANTHROPIC_TOKEN_URL,
  nextAnthropicRefreshMs,
  buildAssertionForm,
  describeExchangeFailure,
  fetchFederatedJwt,
  exchangeAtAnthropic,
  getAnthropicToken,
  startAnthropicOidcRefresh,
};
