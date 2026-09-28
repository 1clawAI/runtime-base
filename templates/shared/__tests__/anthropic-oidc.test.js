"use strict";
/**
 * Anthropic Workload Identity Federation, from inside a runtime.
 *
 * The two-step exchange is documented in docs/agents/oidc-federation.md:
 *
 *   POST {vault}/v1/auth/federated-token   aud=https://api.anthropic.com
 *     → a 1claw-signed RS256 JWT
 *   POST https://api.anthropic.com/v1/oauth/token
 *     grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>
 *     → sk-ant-oat01-…
 *
 * The point is that no Anthropic key is ever stored: the runtime mints a
 * short-lived one whenever it needs it. Which means the refresh has to be
 * right, because there is no static fallback to limp along on — and it has
 * to be quiet, because both halves are credentials and a token in a log is
 * the failure this whole feature exists to avoid.
 *
 * Written before the implementation.
 */
const assert = require("node:assert");
const test = require("node:test");

const {
  nextAnthropicRefreshMs,
  ANTHROPIC_AUDIENCE,
  ANTHROPIC_TOKEN_URL,
  buildAssertionForm,
  describeExchangeFailure,
} = require("../anthropic-oidc.js");

test("the audience and token endpoint match Anthropic's documented values", () => {
  assert.strictEqual(ANTHROPIC_AUDIENCE, "https://api.anthropic.com");
  assert.strictEqual(ANTHROPIC_TOKEN_URL, "https://api.anthropic.com/v1/oauth/token");
});

test("the assertion is form-encoded with the jwt-bearer grant", () => {
  const form = buildAssertionForm("header.payload.sig");
  assert.match(form, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
  assert.match(form, /assertion=header\.payload\.sig/);
});

test("refresh happens before expiry, with room for a retry", () => {
  // 70% of remaining life, the same rule the agent-token renewal uses: a
  // failure leaves time for several more attempts before the credential
  // actually dies.
  const now = 1_000_000;
  const twentyMin = 20 * 60_000;
  assert.strictEqual(
    nextAnthropicRefreshMs(now + twentyMin, now),
    Math.floor(twentyMin * 0.7),
  );

  // Above the ceiling the 70% rule stops applying: a half-hour cap keeps the
  // refresh from being the thing that wakes an idle container, which is the
  // same reason agent-token.js has one.
  const hour = 3_600_000;
  assert.strictEqual(nextAnthropicRefreshMs(now + hour, now), 30 * 60_000);
});

test("a token that is already expired retries soon rather than hammering", () => {
  const now = 1_000_000;
  const delay = nextAnthropicRefreshMs(now - 1, now);
  assert.ok(delay >= 30_000, `expected a floor, got ${delay}`);
});

test("a nonsense expiry does not produce a busy loop or an unbounded wait", () => {
  const now = 1_000_000;
  for (const exp of [0, null, undefined, NaN, now + 10_000_000_000]) {
    const delay = nextAnthropicRefreshMs(exp, now);
    assert.ok(delay >= 30_000 && delay <= 30 * 60_000, `${exp} → ${delay}`);
  }
});

test("a failure is described without quoting the credential", () => {
  // Both the assertion and the returned token are credentials. An error
  // message is the most likely place for one to escape, because it is the
  // thing people paste into a ticket.
  const secret = "sk-ant-oat01-abcdef123456";
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhZ2VudDp4In0.sig";
  const msg = describeExchangeFailure(401, `{"error":"bad assertion ${jwt}","token":"${secret}"}`);
  assert.ok(!msg.includes(secret), `the token leaked into the error: ${msg}`);
  assert.ok(!msg.includes(jwt), `the assertion leaked into the error: ${msg}`);
  assert.match(msg, /401/, "the status is what makes the error actionable");
});

test("the failure text points at the setup step that is usually wrong", () => {
  // A 401 here almost always means Anthropic has not been told about this
  // issuer yet, or the audience does not match. Saying so saves the reader
  // from suspecting their agent key, which is not involved in step 2 at all.
  const msg = describeExchangeFailure(401, "{}");
  assert.match(msg, /audience|provider|console|federation/i);
});
