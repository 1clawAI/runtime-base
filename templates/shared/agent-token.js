"use strict";

/**
 * Shared agent JWT helpers for runtime chat bridges.
 * Vault sends a fresh JWT on each dashboard chat via X-Refreshed-Agent-Token.
 */

let refreshedAgentToken = null;
let refreshedAgentTokenExpMs = null;

function looksLikeJwt(token) {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  return parts.length === 3 && parts[0] && parts[1] && parts[2];
}

function parseJwtExpMs(token) {
  if (!looksLikeJwt(token)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8")
    );
    if (typeof payload.exp === "number" && payload.exp > 0) {
      return payload.exp * 1000;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function acceptRefreshedAgentToken(raw) {
  if (!raw || typeof raw !== "string" || !looksLikeJwt(raw)) return false;
  refreshedAgentToken = raw;
  refreshedAgentTokenExpMs = parseJwtExpMs(raw);
  return true;
}

function getAgentToken() {
  const token =
    refreshedAgentToken ||
    process.env.ONECLAW_AGENT_TOKEN ||
    process.env.ONECLAW_TOKEN ||
    process.env.ONECLAW_AGENT_API_KEY ||
    "";
  if (!token) return "";

  const expMs =
    token === refreshedAgentToken
      ? refreshedAgentTokenExpMs
      : parseJwtExpMs(token);
  if (expMs && Date.now() >= expMs - 60_000) {
    // Prefer env token only when refreshed token is missing/expiring.
    if (token === refreshedAgentToken) {
      const envToken =
        process.env.ONECLAW_AGENT_TOKEN || process.env.ONECLAW_TOKEN || "";
      if (envToken && envToken !== token) {
        const envExp = parseJwtExpMs(envToken);
        if (!envExp || Date.now() < envExp - 60_000) return envToken;
      }
    }
  }
  return token;
}

/** Bearer + runtime binding headers for Vault API calls from cloud runtimes. */
function apiAuthHeaders(token) {
  const bearer = token || getAgentToken();
  const headers = {};
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const runtimeId = process.env.ONECLAW_RUNTIME_ID;
  if (runtimeId) headers["X-1Claw-Runtime-Id"] = runtimeId;
  return headers;
}

/**
 * Renewal, so a long-running runtime stops losing its credential.
 *
 * ONECLAW_AGENT_TOKEN is a ~2h JWT that Cloud Run resolves from Secret Manager
 * when the *instance* starts, and never again. Vault publishes a fresh version
 * every 45 minutes, so a cold start always reads a live one — but an instance
 * that stays up past the TTL keeps what it booted with. The effect was backwards
 * from what anyone would expect: the more continuously a runtime was used, the
 * sooner its credential died, and the only fix the user had was to restart it.
 *
 * `POST /v1/runtimes/{id}/agent-token/renew` is authenticated by the token
 * being replaced, so this introduces no long-lived secret in the container and
 * stops working the moment the token lapses, the agent is suspended or the
 * runtime is no longer deployed.
 */
function vaultBaseUrl() {
  return (
    process.env.ONECLAW_VAULT_INTERNAL_URL ||
    process.env.ONECLAW_BASE_URL ||
    process.env.ONECLAW_API_URL ||
    "https://api.1claw.co"
  ).replace(/\/+$/, "");
}

async function renewAgentToken() {
  const runtimeId = process.env.ONECLAW_RUNTIME_ID;
  const current = getAgentToken();
  if (!runtimeId || !current) return false;

  const resp = await fetch(
    `${vaultBaseUrl()}/v1/runtimes/${encodeURIComponent(runtimeId)}/agent-token/renew`,
    {
      method: "POST",
      headers: { ...apiAuthHeaders(current), "Content-Type": "application/json" },
      body: "{}",
    }
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`renew HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  const json = await resp.json();
  return acceptRefreshedAgentToken(json && json.access_token);
}

/**
 * When to renew next, in milliseconds.
 *
 * At 70% of the remaining life, so a failure leaves room for several more
 * attempts before the token actually dies, and so the renewal is never the
 * thing that wakes an idle container more than a couple of times an hour.
 * Floors and ceilings keep a nonsense `exp` from producing a busy loop or an
 * interval longer than the token it is protecting.
 */
const MIN_RENEW_DELAY_MS = 60_000;
const MAX_RENEW_DELAY_MS = 30 * 60_000;
const RENEW_RETRY_DELAY_MS = 120_000;

function nextRenewDelayMs(expMs, now = Date.now()) {
  if (!expMs) return MAX_RENEW_DELAY_MS;
  const remaining = expMs - now;
  if (remaining <= 0) return MIN_RENEW_DELAY_MS;
  return Math.min(
    MAX_RENEW_DELAY_MS,
    Math.max(MIN_RENEW_DELAY_MS, Math.floor(remaining * 0.7))
  );
}

let renewTimer = null;

/** Idempotent: several servers share this module inside one process. */
function startAgentTokenRenewal() {
  if (renewTimer || !process.env.ONECLAW_RUNTIME_ID) return;

  const schedule = (ms) => {
    renewTimer = setTimeout(tick, ms);
    // Never hold the process open for a renewal.
    if (typeof renewTimer.unref === "function") renewTimer.unref();
  };

  const tick = async () => {
    renewTimer = null;
    try {
      await renewAgentToken();
      console.error("[agent-token] renewed the runtime agent JWT");
      schedule(nextRenewDelayMs(parseJwtExpMs(getAgentToken())));
    } catch (e) {
      // Retrying matters more than reporting: a renewal that fails once with
      // an hour of token left is not yet a problem.
      console.error(`[agent-token] renewal failed, retrying: ${e.message}`);
      schedule(RENEW_RETRY_DELAY_MS);
    }
  };

  schedule(nextRenewDelayMs(parseJwtExpMs(getAgentToken())));
}

function isExpiredSignatureError(status, bodyText) {
  if (status !== 401) return false;
  const lower = (bodyText || "").toLowerCase();
  return lower.includes("expiredsignature") || lower.includes("jwt validation failed");
}

module.exports = {
  acceptRefreshedAgentToken,
  apiAuthHeaders,
  getAgentToken,
  isExpiredSignatureError,
  looksLikeJwt,
  nextRenewDelayMs,
  parseJwtExpMs,
  renewAgentToken,
  startAgentTokenRenewal,
};
