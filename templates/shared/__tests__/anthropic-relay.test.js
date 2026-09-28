"use strict";
/**
 * The loopback relay that makes Anthropic OIDC usable from Hermes.
 *
 * Hermes reads ANTHROPIC_API_KEY once, when it starts. A federated
 * Anthropic token is short-lived by design — that is the whole point of
 * minting one instead of storing a key — so a value injected at boot is
 * wrong within the hour and no sibling process can update it.
 *
 * Same answer as the MCP credential relay: point the framework at
 * 127.0.0.1 and attach the current credential per request. Hermes keeps
 * reading one value (a base URL, which never changes) and the thing that
 * expires is handled where it can be.
 *
 * Written before the implementation.
 */
const assert = require("node:assert");
const test = require("node:test");

const {
  ANTHROPIC_UPSTREAM,
  authHeadersFor,
  DROP_HEADERS,
  upstreamPathFor,
} = require("../anthropic-relay.js");

test("it forwards to Anthropic's real API", () => {
  assert.strictEqual(ANTHROPIC_UPSTREAM, "https://api.anthropic.com");
});

test("the client's own credential headers never reach upstream", () => {
  // Hermes sends whatever ANTHROPIC_API_KEY it was given — which for this
  // path is a placeholder, not a real key. Forwarding it alongside ours
  // would let a stale or bogus value win, depending on Anthropic's
  // precedence, and the failure would look like a 401 from a key nobody
  // configured.
  for (const h of ["x-api-key", "authorization"]) {
    assert.ok(DROP_HEADERS.includes(h), `${h} must be dropped`);
  }
});

test("hop-by-hop headers are dropped", () => {
  // They describe this connection, not the next one.
  for (const h of ["host", "connection", "content-length"]) {
    assert.ok(DROP_HEADERS.includes(h), `${h} must be dropped`);
  }
});

test("the minted token is sent the way Anthropic expects", () => {
  // An `sk-ant-oat01-…` from the OAuth exchange is a bearer token, not an
  // x-api-key. Sending it in the wrong header is a 401 that reads like a
  // bad credential rather than a wrong shape.
  const headers = authHeadersFor("sk-ant-oat01-abc");
  assert.strictEqual(headers.authorization, "Bearer sk-ant-oat01-abc");
  assert.ok(!("x-api-key" in headers), "an OAuth token is not an x-api-key");
});

test("the path and query are preserved", () => {
  // /v1/messages?beta=true must arrive as /v1/messages?beta=true.
  assert.strictEqual(upstreamPathFor("/v1/messages"), "/v1/messages");
  assert.strictEqual(upstreamPathFor("/v1/messages?beta=true"), "/v1/messages?beta=true");
});

test("the path is not doubled when the framework includes a prefix", () => {
  // The MCP relay shipped with exactly this bug — /mcp/mcp — found by
  // hand-walking a request rather than by a test, so this one has a test.
  assert.strictEqual(upstreamPathFor("/v1/complete"), "/v1/complete");
  assert.ok(!upstreamPathFor("/v1/messages").includes("/v1/v1"));
});
