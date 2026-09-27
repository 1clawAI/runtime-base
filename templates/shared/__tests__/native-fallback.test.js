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

/**
 * The dashboard reads `X-1Claw-Chat-Mode` literally: "bridge" means a plain LLM
 * relay, and it responds by labelling the badge "no direct tool access" and
 * hiding every tool command and tool-using suggested prompt. So a tool-enabled
 * turn that reports "bridge" makes a runtime with the full 1Claw toolset look
 * like one without. chat-bridge.js was fixed for this; native-agent-server.js
 * was not, which is the same defect twice in a pair of files.
 */
const fs = require("node:fs");
const path = require("node:path");
const { bridgeChatMode } = require("../native-agent-server.js");

test("a tool-enabled turn is not reported as a plain relay", () => {
  assert.equal(bridgeChatMode(true), "bridge-tools");
  assert.equal(bridgeChatMode(false), "bridge");
});

test("both servers spell the tool-enabled mode the same way", () => {
  // The dashboard matches on the exact string; a typo in either file silently
  // downgrades that server's runtimes.
  const chatBridge = fs.readFileSync(
    path.join(__dirname, "..", "chat-bridge.js"),
    "utf8",
  );
  const emitted = [...chatBridge.matchAll(/"X-1Claw-Chat-Mode":\s*"([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.ok(
    emitted.length > 0,
    "chat-bridge.js no longer sets X-1Claw-Chat-Mode — the dashboard cannot tell what served the turn",
  );
  for (const mode of emitted) {
    assert.ok(
      ["bridge", "bridge-tools", "native"].includes(mode),
      `chat-bridge.js emits an unrecognised chat mode "${mode}"`,
    );
  }
  assert.ok(
    emitted.includes(bridgeChatMode(true)),
    `chat-bridge.js runs tools but never emits "${bridgeChatMode(true)}" — the two servers have drifted`,
  );
});

/**
 * `hermes gateway` takes its bearer from `API_SERVER_KEY` when the container
 * has one, and only otherwise from the handoff file:
 *
 *   API_SERVER_KEY="${API_SERVER_KEY:-$(cat native-loopback-token)}"
 *
 * The bridge only ever read the file. So a runtime whose own environment set
 * API_SERVER_KEY — a perfectly ordinary thing to do — gave Hermes one bearer
 * and the bridge another, and every dashboard turn 401'd and silently fell
 * through to a different agent. Permanently, with nothing the user could see
 * or do. These pin the two to the same resolution order.
 */
const { resolveHermesToken } = require("../native-agent-server.js");

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// A path that cannot exist, so the file branch is out of the picture.
const NO_FILE = "/nonexistent/1claw-test/native-loopback-token";

test("the bridge uses the key Hermes was actually started with", () => {
  const got = withEnv(
    {
      ONECLAW_HERMES_NATIVE_TOKEN: undefined,
      API_SERVER_KEY: "key-from-the-runtime-environment",
      ONECLAW_HERMES_TOKEN_FILE: NO_FILE,
    },
    resolveHermesToken,
  );
  assert.equal(got, "key-from-the-runtime-environment");
});

test("an explicit 1Claw override still wins", () => {
  const got = withEnv(
    {
      ONECLAW_HERMES_NATIVE_TOKEN: "explicit-override",
      API_SERVER_KEY: "key-from-the-runtime-environment",
      ONECLAW_HERMES_TOKEN_FILE: NO_FILE,
    },
    resolveHermesToken,
  );
  assert.equal(got, "explicit-override");
});

test("no key anywhere is empty, not a crash", () => {
  const got = withEnv(
    {
      ONECLAW_HERMES_NATIVE_TOKEN: undefined,
      API_SERVER_KEY: undefined,
      ONECLAW_HERMES_TOKEN_FILE: NO_FILE,
    },
    resolveHermesToken,
  );
  assert.equal(got, "");
});

/**
 * The dashboard decides whether a runtime's container is behind by what it
 * reports on the chat stream — and by the *absence* of a report, since
 * containers predating this send nothing. So every path that serves a turn has
 * to report, or a perfectly current runtime reads as stale. Hermes serves most
 * of its turns through the native proxy, which is the path easiest to forget.
 */
const { RUNTIME_FEATURES } = require("../native-agent-server.js");

test("every streaming path reports the container's capabilities", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "native-agent-server.js"), "utf8");
  // Count call sites only. `function writeRuntimeMeta(res)` contains the call
  // pattern as a substring, so a naive split counts the declaration and the
  // test passes with a call site removed — which is how it first behaved.
  const calls = (src.match(/(?<!function\s)writeRuntimeMeta\(res\)/g) || []).length;
  assert.ok(
    calls >= 3,
    `writeRuntimeMeta is called ${calls} times; the bridge tool loop, the plain ` +
      `streaming passthrough and the native proxy each need it, or runtimes served ` +
      `by the missing one look stale to the dashboard`,
  );
});

test("chat-bridge reports from both of its SSE paths", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "chat-bridge.js"), "utf8");
  assert.ok(
    src.includes("agent_token_renewal"),
    "chat-bridge.js must claim agent_token_renewal — it starts the renewal loop",
  );
  // It opens SSE in two places: the tool loop, and the tool-less passthrough
  // below it. The second was missed on the first pass, which would have told
  // everyone running a tools-disabled runtime that they were behind when they
  // were not — this repo's most common defect shape, one of two symmetric
  // paths getting the change.
  const calls = (src.match(/(?<!function\s)writeRuntimeMeta\(res\)/g) || []).length;
  assert.equal(
    calls,
    2,
    `writeRuntimeMeta is called ${calls} times in chat-bridge.js; both the tool ` +
      `loop and the tool-less streaming passthrough need it`,
  );
});

test("the feature names the dashboard requires are actually claimed", () => {
  // The dashboard's REQUIRED_RUNTIME_FEATURES matches on these exact strings;
  // a rename on either side silently marks every runtime as behind.
  assert.ok(RUNTIME_FEATURES.includes("agent_token_renewal"));
  for (const f of RUNTIME_FEATURES) {
    assert.match(f, /^[a-z0-9_]+$/, `"${f}" is not a stable lowercase identifier`);
  }
});

/**
 * Timeline from a real Hermes cold start (runtime 8b82d882, 2026-09-27):
 *
 *   11:42:01  container serving
 *   11:42:04  chat turn arrives; probe fails; answered as the bridge
 *   11:42:09  `hermes gateway` prints "Starting"
 *   11:42:33  gateway has loaded its state DB, MCP servers and tool config
 *
 * The grace was about five seconds, so it conceded at 11:42:04 and the user
 * got the wrong agent — while the right one was thirty seconds away. Being
 * patient is only correct while the container is young, though: a gateway that
 * has not appeared minutes after boot is not coming, and waiting forty seconds
 * on every later turn to rediscover that would be its own bug.
 */
const { nativeWaitBudgetMs } = require("../native-agent-server.js");

test("a booting container waits long enough for the gateway to appear", () => {
  const boot = 1_700_000_000_000;
  // The window that actually mattered: a turn four seconds after boot.
  const budget = nativeWaitBudgetMs(boot + 4_000, boot);
  assert.ok(
    budget >= 30_000,
    `waits only ${budget}ms four seconds into boot; Hermes needed about thirty seconds`,
  );
});

test("patience expires with the startup window", () => {
  const boot = 1_700_000_000_000;
  const settled = nativeWaitBudgetMs(boot + 10 * 60_000, boot);
  assert.ok(
    settled <= 5_000,
    `still waiting ${settled}ms ten minutes in — every turn would stall on a gateway that is not coming`,
  );
  assert.ok(settled > 0, "a settled container must still probe at least briefly");
});

test("the budget only ever shrinks with age", () => {
  const boot = 1_700_000_000_000;
  let prev = Infinity;
  for (const min of [0, 1, 2, 3, 5, 30]) {
    const b = nativeWaitBudgetMs(boot + min * 60_000, boot);
    assert.ok(b <= prev, `budget grew at ${min}m: ${b} > ${prev}`);
    prev = b;
  }
});

/**
 * The dashboard's tools card is a *prediction*: it derives what tools an agent
 * should have from its template, its config and its env vars. The container
 * knows what it actually registered, and /health already reports it — but
 * nothing outside the container can reach /health, so the prediction is all
 * anyone sees.
 *
 * They already disagree. `execute_code` is enabled by default for Hermes and
 * shown as active, while Hermes refuses it on unattended sessions ("This
 * session runs on an unattended platform") — so the card claims a capability
 * that dashboard chat cannot use.
 *
 * The capability frame already reaches the panel on every streamed turn. The
 * tool list rides along with it, so what the UI shows can be what the
 * container reports rather than what we guessed.
 */
test("the capability frame carries the container's real tool list", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "native-agent-server.js"), "utf8");
  const at = src.indexOf("function writeRuntimeMeta");
  assert.ok(at > -1, "writeRuntimeMeta is gone");
  const body = src.slice(at, at + 900);
  assert.ok(
    body.includes("tools"),
    "the frame reports features but not which tools the agent actually has, so " +
      "the dashboard can only guess",
  );
});

test("the tool list is the one the agent was actually given", () => {
  // Not a hardcoded list: it has to come from the same definitions the agent
  // is handed, or it is just a second prediction that can drift from the
  // first.
  const src = fs.readFileSync(path.join(__dirname, "..", "native-agent-server.js"), "utf8");
  const at = src.indexOf("function runtimeToolNames");
  assert.ok(at > -1, "runtimeToolNames is missing");
  const body = src.slice(at, at + 500);
  assert.ok(
    body.includes("ALL_TOOL_DEFINITIONS"),
    "the reported list must derive from ALL_TOOL_DEFINITIONS, the definitions " +
      "actually sent to the model",
  );
});
