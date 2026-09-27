"use strict";
/**
 * `ONECLAW_AGENT_TOKEN` is a ~2h JWT that Cloud Run resolves from Secret
 * Manager when the *instance* starts, and never again. Vault publishes a fresh
 * version every 45 minutes, so a cold start always reads a live one — but an
 * instance that stays up past the TTL keeps what it booted with, and every
 * credentialed call then 401s. The effect was backwards: the more continuously
 * a runtime was used, the sooner its credential died, and the only fix the user
 * had was to restart it. Hermes caches the token at boot, so its whole MCP
 * toolset went with it.
 *
 * These cover the scheduling arithmetic, which is the part that decides whether
 * renewal happens before or after the token it is protecting expires.
 *
 * Run: node --test templates/shared/__tests__/agent-token-renewal.test.js
 */
const test = require("node:test");
const assert = require("node:assert");

const { nextRenewDelayMs } = require("../agent-token.js");

const MINUTE = 60_000;

test("renews well before the token expires", () => {
  const now = Date.now();
  // A fresh 2h token: renew around 84 minutes in, capped at the 30-minute
  // ceiling — either way, comfortably inside its life.
  const delay = nextRenewDelayMs(now + 120 * MINUTE, now);
  assert.ok(
    delay < 120 * MINUTE,
    `renewal at ${delay}ms would fire after a 2h token had already expired`,
  );
});

test("never schedules past the life of the token it is protecting", () => {
  const now = Date.now();
  for (const remainingMinutes of [1, 5, 20, 45, 90, 120, 24 * 60]) {
    const remaining = remainingMinutes * MINUTE;
    const delay = nextRenewDelayMs(now + remaining, now);
    assert.ok(
      delay <= Math.max(remaining, MINUTE),
      `with ${remainingMinutes}m left it would wait ${delay / MINUTE}m — the token dies first`,
    );
  }
});

test("an already-expired token retries soon rather than never", () => {
  const now = Date.now();
  assert.equal(nextRenewDelayMs(now - MINUTE, now), MINUTE);
  assert.equal(nextRenewDelayMs(now, now), MINUTE);
});

test("never busy-loops", () => {
  const now = Date.now();
  // Down to the last second of a token, the floor still applies: a renewal
  // storm against Vault is worse than one late attempt.
  for (const remainingMs of [0, 1, 100, 5_000, 59_000]) {
    assert.ok(
      nextRenewDelayMs(now + remainingMs, now) >= MINUTE,
      `${remainingMs}ms of life produced a sub-minute retry interval`,
    );
  }
});

test("a token with no usable exp still gets renewed eventually", () => {
  // parseJwtExpMs returns null for a malformed or exp-less token. Falling back
  // to the ceiling means renewal still happens — better than treating "I can't
  // read the expiry" as "it never expires", which is how this broke.
  assert.equal(nextRenewDelayMs(null), 30 * MINUTE);
  assert.equal(nextRenewDelayMs(undefined), 30 * MINUTE);
  assert.equal(nextRenewDelayMs(0), 30 * MINUTE);
});

test("the renewal loop is wired into both servers that serve chat", () => {
  // The helper existing is not the fix; something has to start it. Checked
  // here because forgetting the call site is silent — the token simply
  // expires as it always did.
  const fs = require("node:fs");
  const path = require("node:path");
  for (const file of ["native-agent-server.js", "chat-bridge.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.ok(
      /startAgentTokenRenewal\(\)/.test(src),
      `${file} never calls startAgentTokenRenewal() — its agent JWT still dies at the TTL`,
    );
  }
});
