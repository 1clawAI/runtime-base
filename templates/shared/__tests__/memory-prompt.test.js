/**
 * The system prompt must not instruct the agent to claim a save it did not make.
 *
 * Production, 2026-09-28. A user gave their Hermes agent a long growth plan
 * and asked it to remember it. It answered:
 *
 *   "Saved. I'll remember 1Claw, the 1M user goal, and the full growth
 *    strategy across all future sessions."
 *
 * Nothing was stored by the agent. Asked "what is your goal" a minute later
 * it gave a generic answer about being a helpful assistant.
 *
 * The `remember` tool was in the tool list for that request the whole time.
 * The model simply was never told to call it — the prompt said:
 *
 *   "When the user shares preferences, goals, or asks you to remember
 *    something, confirm that it is stored in durable memory."
 *
 * An instruction to confirm, with no instruction to store. The model
 * complied. A confirmation the prompt manufactures is not evidence of
 * anything, and it is worse than silence: the user stopped checking.
 *
 * These assertions are on the prompt text, because the prompt is the bug.
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "chat-bridge.js"), "utf8");

/** The `memoryLines` block, which is what shapes this behaviour. */
function memoryBlock() {
  const start = SRC.indexOf("const memoryLines = memoryEnabled");
  assert.notEqual(start, -1, "memoryLines block not found — was it renamed?");
  const end = SRC.indexOf("const parts = [", start);
  assert.notEqual(end, -1);
  return SRC.slice(start, end);
}

test("the prompt tells the agent to call the tool, not merely to confirm", () => {
  const block = memoryBlock();
  assert.match(
    block,
    /MUST call the `remember` tool/,
    "the prompt has to name the tool and require it; describing memory as a capability is what produced a confident non-save",
  );
});

test("the prompt forbids claiming a save that no tool confirmed", () => {
  const block = memoryBlock();
  assert.match(
    block,
    /Never tell the user something has been saved unless a tool call returned success/,
  );
});

test("the old instruction to confirm-regardless is gone", () => {
  const block = memoryBlock();
  // The exact sentence that shipped the bug. If it ever comes back — in a
  // merge, or because it reads reassuring — this fails.
  assert.doesNotMatch(
    block,
    /asks you to remember something, confirm that it is stored/,
    "this sentence asks for a confirmation and never asks for a store",
  );
});

test("the agent is told that \"remember it\" means the subject, not the pronoun", () => {
  const block = memoryBlock();
  assert.match(
    block,
    /not the pronoun/,
    'the server-side extractor stored `it?` for "save it and remember it"; the model must not do the same in its tool call',
  );
});

test("with the tool missing, the agent is told to say so rather than pretend", () => {
  const block = memoryBlock();
  assert.match(block, /rememberToolAvailable/);
  assert.match(
    block,
    /not loaded in this session/,
    "when the tool is absent the honest answer is that it cannot store, not a cheerful confirmation",
  );
});

test("availability is read off the Map the registry actually returns", () => {
  // getAvailableTools returns `{ definitions, modules }` where `modules` is a
  // Map keyed by tool name. An earlier draft of this fix called
  // `toolModules.some(...)`, which throws on a Map — the prompt would have
  // 500'd every chat instead of merely being wrong.
  const registry = fs.readFileSync(
    path.join(__dirname, "..", "tools", "tool-registry.js"),
    "utf8",
  );
  assert.match(
    registry,
    /const modules = new Map\(\)/,
    "if modules stops being a Map, chat-bridge's .has() check must change with it",
  );
  assert.match(SRC, /toolModules\.has\("remember"\)/);
  assert.doesNotMatch(SRC, /toolModules\.some\(/, "Map has no .some()");
});

test("memory-off still explains where to turn it on", () => {
  const block = memoryBlock();
  assert.match(block, /toggle Agent Memory on/);
});
