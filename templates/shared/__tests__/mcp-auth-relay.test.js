"use strict";
/**
 * Hermes' MCP client is configured once, at startup, from a file containing a
 * literal `Authorization: Bearer <jwt>` — the runtime's ~2h agent token. A
 * bearer baked into a config file cannot be refreshed, so when it expired every
 * MCP call 401'd, Hermes parked the server after three attempts, and the agent
 * silently lost the entire 1claw toolset while carrying on answering. The only
 * remedy the user had was to restart the runtime.
 *
 * The relay exists so that header is replaced with a live one on the way past.
 * If it ever forwards the stale bearer instead, the bug is back and looks
 * exactly the same as before — which is what these pin down.
 *
 * Run: node --test templates/shared/__tests__/mcp-auth-relay.test.js
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

process.env.ONECLAW_AGENT_TOKEN =
  "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhZ2VudDp0ZXN0IiwiZXhwIjo5OTk5OTk5OTk5fQ.sig";
process.env.ONECLAW_VAULT_ID = "vault-under-test";

const { forwardHeaders, DROP_HEADERS } = require("../mcp-auth-relay.js");

test("the caller's stale bearer never reaches upstream", () => {
  const out = forwardHeaders({
    authorization: "Bearer the-expired-one-baked-into-hermes-config",
    "content-type": "application/json",
  });
  assert.ok(!/the-expired-one/.test(JSON.stringify(out)), "forwarded the stale bearer");
  assert.equal(out.Authorization, `Bearer ${process.env.ONECLAW_AGENT_TOKEN}`);
});

test("host is not forwarded", () => {
  // It would name the loopback listener, and TLS/SNI and most routers key off
  // it — the upstream would reject or misroute the request.
  const out = forwardHeaders({ host: "127.0.0.1:8766", accept: "text/event-stream" });
  assert.ok(!("host" in out) && !("Host" in out));
  assert.equal(out.accept, "text/event-stream");
});

test("hop-by-hop headers describe this connection, not the next", () => {
  const hop = {
    connection: "keep-alive",
    "keep-alive": "timeout=5",
    "transfer-encoding": "chunked",
    upgrade: "h2c",
    te: "trailers",
    trailer: "X-Thing",
    "proxy-authorization": "Basic x",
    "proxy-authenticate": "Basic",
    "content-length": "42",
  };
  const out = forwardHeaders(hop);
  for (const k of Object.keys(hop)) {
    assert.ok(!(k in out), `${k} must not be forwarded`);
    assert.ok(DROP_HEADERS.has(k), `${k} should be in the drop set`);
  }
});

test("everything else passes through untouched", () => {
  const out = forwardHeaders({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-session-id": "abc123",
  });
  assert.equal(out["content-type"], "application/json");
  assert.equal(out["mcp-session-id"], "abc123");
});

test("the vault id is supplied but never overridden", () => {
  assert.equal(forwardHeaders({})["X-Vault-ID"], "vault-under-test");
  // A caller that set its own must win — the relay is a credential shim, not
  // a router.
  const explicit = forwardHeaders({ "x-vault-id": "caller-chose-this" });
  assert.equal(explicit["x-vault-id"], "caller-chose-this");
  assert.ok(!("X-Vault-ID" in explicit), "added a second, conflicting vault id header");
});

test("the Hermes image ships the relay and starts it before writing MCP config", () => {
  // Three things have to line up, and each is silent on its own: the file in
  // the image, the start script launching it, and ONECLAW_MCP_URL being
  // repointed *before* 1claw-hermes writes the config that bakes the bearer.
  const root = path.join(__dirname, "..", "..");
  const dockerfile = fs.readFileSync(path.join(root, "hermes", "Dockerfile"), "utf8");
  assert.ok(
    /COPY\s+shared\/mcp-auth-relay\.js\s+\/app\/mcp-auth-relay\.js/.test(dockerfile),
    "hermes/Dockerfile does not ship mcp-auth-relay.js",
  );

  const start = fs.readFileSync(path.join(root, "shared", "hermes-agent-start.sh"), "utf8");
  const relayAt = start.indexOf("mcp-auth-relay.js");
  const configAt = start.indexOf("1claw-hermes-runtime-start");
  assert.ok(relayAt > -1, "hermes-agent-start.sh never starts the relay");
  assert.ok(configAt > -1, "hermes-agent-start.sh no longer runs the 1claw-hermes patch");
  assert.ok(
    relayAt < configAt,
    "the relay must be started and ONECLAW_MCP_URL repointed before 1claw-hermes writes the MCP config, or the config still bakes in a bearer that expires",
  );
  assert.ok(
    /export ONECLAW_MCP_URL=/.test(start),
    "ONECLAW_MCP_URL is never repointed at the relay, so Hermes still talks to the remote endpoint directly",
  );
});

const { upstreamPathFor } = require("../mcp-auth-relay.js");

test("the upstream path is not doubled", () => {
  // The relay is addressed at the same path it forwards to: Hermes is pointed
  // at http://127.0.0.1:8766/mcp and the upstream is https://mcp.1claw.co/mcp.
  // Appending the incoming path — the obvious thing to write, and what the
  // first version of this file did — yields /mcp/mcp and 404s every call.
  assert.equal(upstreamPathFor("/mcp"), "/mcp");
  assert.equal(upstreamPathFor("/"), "/mcp");
  assert.equal(upstreamPathFor(undefined), "/mcp");
});

test("a query string carries over", () => {
  assert.equal(upstreamPathFor("/mcp?sessionId=abc"), "/mcp?sessionId=abc");
});
