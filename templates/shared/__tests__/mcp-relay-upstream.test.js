"use strict";
/**
 * MCPRELAY-M1. The relay attaches a continually renewed agent JWT to every
 * request it forwards, and took its destination from
 * `ONECLAW_MCP_UPSTREAM_URL` — which a tenant can set, because neither that
 * key nor `ONECLAW_MCP_URL` was in the vault's platform-controlled list. It
 * accepted any host, including plain `http:`.
 *
 * So an org member who can edit env vars pointed it at their own server and
 * collected fresh agent tokens, indefinitely, because the relay keeps
 * renewing them.
 *
 * This is NATIVEURL-L1 one component over: `ONECLAW_HERMES_NATIVE_URL` was
 * the same shape and was fixed by adding it to that list. The list alone is
 * not enough here — it governs `env_public`, and the relay should not be
 * willing to send a credential to an arbitrary host whatever its environment
 * says. So the host is pinned in the relay too.
 *
 * Written before the implementation.
 */
const assert = require("node:assert");
const test = require("node:test");

const { resolveUpstream, ALLOWED_UPSTREAM_HOSTS } = require("../mcp-auth-relay.js");

test("the default upstream is the hosted MCP server", () => {
  assert.strictEqual(resolveUpstream(undefined), "https://mcp.1claw.co/mcp");
  assert.strictEqual(resolveUpstream(""), "https://mcp.1claw.co/mcp");
});

test("both brand domains are allowed", () => {
  // The platform serves .co and .xyz; pinning only one would break the other.
  for (const host of ALLOWED_UPSTREAM_HOSTS) {
    assert.strictEqual(
      resolveUpstream(`https://${host}/mcp`),
      `https://${host}/mcp`,
      `${host} should be accepted`,
    );
  }
  assert.ok(ALLOWED_UPSTREAM_HOSTS.includes("mcp.1claw.co"));
  assert.ok(ALLOWED_UPSTREAM_HOSTS.includes("mcp.1claw.xyz"));
});

test("an unknown host is refused, not silently used", () => {
  // The attack: the tenant's own collector.
  assert.throws(
    () => resolveUpstream("https://evil.example/mcp"),
    /evil\.example/,
    "the error should name the host that was refused",
  );
});

test("a lookalike host does not pass", () => {
  // Suffix matching would accept these; exact host matching does not.
  // The third is the userinfo trick: `new URL(...)` reads that hostname as
  // evil.example, so it is caught — but by the credentials check rather than
  // the host check, which is why this asserts refusal rather than a
  // particular sentence.
  for (const bad of [
    "https://mcp.1claw.co.evil.example/mcp",
    "https://notmcp.1claw.co/mcp",
    "https://mcp.1claw.co@evil.example/mcp",
  ]) {
    assert.throws(() => resolveUpstream(bad), Error, `${bad} should be refused`);
    let message = "";
    try {
      resolveUpstream(bad);
    } catch (e) {
      message = e.message;
    }
    assert.ok(
      message.includes("evil.example") || message.includes("notmcp.1claw.co"),
      `the refusal should name what it refused, got: ${message}`,
    );
  }
});

test("plain http is refused even for an allowed host", () => {
  // The token is the payload; sending it in clear defeats the point.
  assert.throws(() => resolveUpstream("http://mcp.1claw.co/mcp"), /https/i);
});

test("a trailing slash is normalised, not treated as a different host", () => {
  assert.strictEqual(resolveUpstream("https://mcp.1claw.co/mcp/"), "https://mcp.1claw.co/mcp");
});
