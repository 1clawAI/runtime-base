"use strict";
/**
 * `getGitHubConnection` (and its identical twins for Google and Slack) returned
 * `null` for three unrelated situations: the connections endpoint answered
 * 4xx/5xx, the call threw, or the agent genuinely has no such connection. Every
 * caller reported all three the same way —
 *
 *   "No GitHub OAuth connection found for this agent"
 *
 * — so an expired agent token, a vault error or a network blip all told the
 * user to go and connect an account that was already connected. They then
 * reconnect it, nothing changes, and the real fault is never looked at.
 *
 * Same misdirection as a content guardrail returning 403 and clients blaming
 * the API key: a transient failure dressed up as a configuration mistake the
 * user cannot fix, because it is not one.
 *
 * Run: node --test templates/shared/tools/__tests__/connection-lookup.test.js
 */
const test = require("node:test");
const assert = require("node:assert");

const { connectionLookupFailure } = require("../connection-lookup.js");

test("an auth failure is not reported as a missing connection", () => {
  const msg = connectionLookupFailure({ provider: "GitHub", status: 401 });
  assert.match(msg, /GitHub/);
  assert.ok(
    !/no github oauth connection found/i.test(msg),
    `an expired credential must not read as "you have not connected GitHub": ${msg}`,
  );
  assert.match(msg, /401/);
});

test("a server error says so rather than blaming setup", () => {
  const msg = connectionLookupFailure({ provider: "Slack", status: 503 });
  assert.match(msg, /503/);
  assert.ok(!/have not connected|not connected/i.test(msg));
});

test("a thrown call reports the transport failure", () => {
  const msg = connectionLookupFailure({
    provider: "Google",
    threw: "ECONNRESET",
  });
  assert.match(msg, /ECONNRESET/);
  assert.ok(!/no google oauth connection/i.test(msg));
});

test("genuinely absent is still reported as absent", () => {
  // The one case where telling someone to connect the account is right.
  const msg = connectionLookupFailure({ provider: "GitHub", absent: true });
  assert.match(msg, /connect/i);
  assert.match(msg, /GitHub/);
});

test("every message names the provider and suggests a next step", () => {
  // An agent relays these to a person; "lookup failed" with no provider and no
  // action is not something anyone can act on.
  for (const opts of [
    { provider: "GitHub", status: 500 },
    { provider: "Slack", threw: "timeout" },
    { provider: "Google", absent: true },
  ]) {
    const msg = connectionLookupFailure(opts);
    assert.match(msg, new RegExp(opts.provider));
    assert.ok(msg.length > 30, `too terse to act on: ${msg}`);
  }
});

const fs = require("node:fs");
const path = require("node:path");

/**
 * The describer is worthless if the tools still collapse every failure to the
 * same sentence. All three were copies of one another, so all three had it.
 */
test("no connected-account tool blames setup unconditionally", () => {
  const offenders = [];
  for (const slug of ["github", "google", "slack"]) {
    const src = fs.readFileSync(
      path.join(__dirname, "..", `${slug}-tools.js`),
      "utf8",
    );
    if (/No \w+ OAuth connection found for this agent/.test(src)) offenders.push(slug);
    if (!src.includes("connectionLookupFailure")) offenders.push(`${slug} (not wired)`);
  }
  assert.deepEqual(
    offenders,
    [],
    "these still report an auth failure, a server error and a genuinely absent " +
      "connection with the same message, sending users to reconnect an account " +
      "that is already connected",
  );
});

test("the lookup records why, not just that it failed", () => {
  for (const slug of ["github", "google", "slack"]) {
    const src = fs.readFileSync(
      path.join(__dirname, "..", `${slug}-tools.js`),
      "utf8",
    );
    // A bare `return null` on the error paths is the original bug.
    assert.ok(
      src.includes("_lastLookupFailure = connectionLookupFailure"),
      `${slug}-tools.js discards the reason its lookup failed`,
    );
  }
});

const { channelLookupFailure } = require("../connection-lookup.js");

/**
 * The notify tools had the same defect in a worse form. `fetchChannels`
 * returned `[]` for any 4xx/5xx, `findChannel` then found nothing, and the
 * tool told the user:
 *
 *   "No active Telegram channel found. Connect one via the dashboard…"
 *
 * An empty list is a stronger claim than a null: it does not say "I could not
 * find it", it says "there are none". So an expired token made the agent
 * assert, with confidence, that a channel the user is looking at does not
 * exist.
 */
test("an unreachable channel list is not an empty channel list", () => {
  const msg = channelLookupFailure({ type: "Telegram", status: 401 });
  assert.match(msg, /Telegram/);
  assert.match(msg, /401/);
  assert.ok(
    !/connect one/i.test(msg),
    `must not tell someone to connect a channel that may already exist: ${msg}`,
  );
});

test("a server error does not become 'you have no channel'", () => {
  const msg = channelLookupFailure({ type: "Discord", status: 500 });
  assert.ok(!/no active/i.test(msg), msg);
  assert.match(msg, /500/);
});

test("genuinely absent still says how to add one", () => {
  const msg = channelLookupFailure({ type: "Telegram", absent: true });
  assert.match(msg, /connect|channel_id/i);
});

test("the notify tools no longer collapse errors into an empty list", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "notify-tools.js"),
    "utf8",
  );
  assert.ok(
    !/if \(resp\.status >= 400\) return \[\];/.test(src),
    "fetchChannels still swallows an HTTP error as an empty channel list, so " +
      "the agent asserts the user has no channel when the lookup merely failed",
  );
  assert.ok(src.includes("channelLookupFailure"), "notify-tools is not wired to it");
});
