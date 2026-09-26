"use strict";
/**
 * When a framework's own gateway (Hermes, OpenClaw) cannot serve a chat turn,
 * the bridge answers instead. That is a *different agent* — its own loop, its
 * own model, none of the framework's memory, skills or MCP tools — and it used
 * to happen silently. A Hermes runtime with memory enabled answered "I don't
 * have a mechanism to set a persistent goal", because the thing answering was
 * not Hermes.
 *
 * The fallback still exists (it is better than no answer), but it now reports
 * why, so the dashboard can offer the remedy that matches: reconnect on an auth
 * failure, restart on a missing endpoint, neither on an upstream error.
 *
 * Run: node --test templates/shared/__tests__/native-fallback.test.js
 */
const test = require("node:test");
const assert = require("node:assert");

const { nativeFailureReason, toChatCompletionsUrl } = require("../native-agent-server.js");

test("auth failures are distinguishable from every other failure", () => {
  assert.equal(nativeFailureReason(401), "auth");
  assert.equal(nativeFailureReason(403), "auth");

  // The whole point of the classifier: nothing else may be reported as auth,
  // or the dashboard sends people to re-authenticate against a problem that
  // re-authenticating cannot fix.
  for (const status of [0, 404, 405, 429, 500, 502, 503]) {
    assert.notEqual(
      nativeFailureReason(status),
      "auth",
      `${status} must not be reported as an auth failure`,
    );
  }
});

test("a missing endpoint is its own case", () => {
  // 404 means the gateway is listening but has no chat-completions route —
  // an image predating the native API server. Restarting fixes it; nothing
  // else here does.
  assert.equal(nativeFailureReason(404), "not_enabled");
});

test("no status at all means we never reached it", () => {
  assert.equal(nativeFailureReason(0), "unreachable");
  assert.equal(nativeFailureReason(undefined), "unreachable");
});

test("5xx is the gateway's own problem, not ours", () => {
  assert.equal(nativeFailureReason(500), "upstream_error");
  assert.equal(nativeFailureReason(503), "upstream_error");
  assert.equal(nativeFailureReason(429), "error");
});

test("every reason is a string the dashboard has a case for", () => {
  // Kept in step with the reasons handled in runtime-chat-panel.tsx. A new
  // reason added here without a case there degrades to a generic notice, which
  // is the failure this test exists to catch early.
  const KNOWN = new Set(["auth", "not_enabled", "unreachable", "upstream_error", "error"]);
  for (const status of [0, 401, 403, 404, 418, 429, 500, 599]) {
    assert.ok(
      KNOWN.has(nativeFailureReason(status)),
      `${status} produced an unhandled reason: ${nativeFailureReason(status)}`,
    );
  }
});

test("gateway base URLs normalise to one endpoint", () => {
  // The start script and the proxy must not drift over whether the configured
  // value carries /v1.
  const want = "http://127.0.0.1:8642/v1/chat/completions";
  assert.equal(toChatCompletionsUrl("http://127.0.0.1:8642"), want);
  assert.equal(toChatCompletionsUrl("http://127.0.0.1:8642/v1"), want);
  assert.equal(toChatCompletionsUrl("http://127.0.0.1:8642/v1/"), want);
  assert.equal(toChatCompletionsUrl("http://127.0.0.1:8642/v1/chat/completions"), want);
});
