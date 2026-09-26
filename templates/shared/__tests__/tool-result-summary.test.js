"use strict";
/**
 * Tool *results* never reached the browser — only the name, redacted
 * arguments, and whether the call failed. So a transcript could show that
 * the agent called `list_secrets`, but not what came back; when the agent
 * then said "you have three secrets", there was nothing to check it
 * against.
 *
 * Results cannot simply be forwarded: `get_secret` returns the secret. This
 * derives shape only. The tests that matter are the ones proving a value
 * never survives.
 *
 * Run: node --test templates/shared/__tests__/tool-result-summary.test.js
 */
const test = require("node:test");
const assert = require("node:assert");

const { summarizeToolResult } = require("../message-sanitize.js");

test("describes shape, never content", () => {
  const SECRET = "sk-live-51H8xQ2eZvKYlo0T7AbCdEf";
  for (const result of [
    SECRET,
    { value: SECRET },
    { secret: { value: SECRET } },
    [SECRET, SECRET],
    { items: [{ value: SECRET }] },
    { data: SECRET },
  ]) {
    const out = summarizeToolResult(result);
    assert.ok(typeof out === "string", `expected a description, got ${out}`);
    assert.ok(
      !out.includes(SECRET) && !out.includes("sk-live"),
      `the summary leaked the value: ${out}`,
    );
    // Nor any fragment — no partial echo either.
    assert.ok(!/[A-Za-z0-9]{12,}/.test(out), `summary looks like echoed content: ${out}`);
  }
});

test("counts the shapes tools actually return", () => {
  assert.strictEqual(summarizeToolResult([1, 2, 3]), "3 items");
  assert.strictEqual(summarizeToolResult({ secrets: [{}, {}] }), "2 items");
  assert.strictEqual(summarizeToolResult({ results: [{}] }), "1 item");
  assert.strictEqual(summarizeToolResult({ count: 12 }), "12 items");
  assert.strictEqual(summarizeToolResult({ ok: true }), "ok");
  assert.strictEqual(summarizeToolResult({}), "empty");
});

test("says nothing when there is nothing to say", () => {
  assert.strictEqual(summarizeToolResult(null), undefined);
  assert.strictEqual(summarizeToolResult(undefined), undefined);
});

test("both emitters send it, live and persisted", () => {
  // The recurring shape in this repo is one of two symmetric paths getting
  // the change — this very edit missed the native server's live event on
  // the first pass, because its `round: rounds` did not match the other
  // file's `round,`.
  const fs = require("node:fs");
  const path = require("node:path");
  for (const file of ["chat-bridge.js", "native-agent-server.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.ok(
      src.includes("summarizeToolResult,"),
      `${file} does not import the summariser`,
    );
    const uses = src.split("resultSummary ? { resultSummary }").length - 1;
    assert.strictEqual(
      uses,
      2,
      `${file} should attach the summary to both the live event and the ` +
        `persisted summary, found ${uses}`,
    );
  }
});
