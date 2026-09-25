#!/usr/bin/env node
/**
 * 1Claw Native Agent Server
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ Dual-Stack Architecture                                                  │
 * │                                                                          │
 * │ Background: Native gateway (Hermes or OpenClaw) runs its own LLM loop   │
 * │   with channel connectors, message queue, and persistence.               │
 * │                                                                          │
 * │ Foreground: This server (native-agent-server.js) provides the 1Claw     │
 * │   bridge — an OpenAI-compatible /v1/chat/completions endpoint with:      │
 * │   - Multi-turn tool calling (vault, memory, automations, registry tools) │
 * │   - Shroud-routed LLM (per-org redaction, PII, injection scoring)        │
 * │   - Agent memory persistence via 1Claw Memory API                        │
 * │   - Platform chat integration (dashboard, runtime /chat endpoint)        │
 * │                                                                          │
 * │ The sidecar (shroud-sidecar) handles inbound auth and proxies external   │
 * │ HTTP on PUBLIC_PORT → this server on USER_PORT. Shell/terminal traffic   │
 * │ is also multiplexed through the sidecar.                                 │
 * │                                                                          │
 * │ When ONECLAW_AGENT_ID is set (platform-managed runtime):                 │
 * │   - Native gateway channels are disabled (entrypoint sets *_DISABLE_*)   │
 * │   - Channels are managed by the platform (Channels API + slash_commands) │
 * │   - This server is the primary chat interface for the agent              │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Env:
 *   PORT / USER_PORT, ONECLAW_FRAMEWORK, ONECLAW_AGENT_ID, ONECLAW_RUNTIME_ID,
 *   ONECLAW_AGENT_TOKEN / ONECLAW_TOKEN, ONECLAW_VAULT_ID,
 *   ONECLAW_SHROUD_ENABLED, ONECLAW_SHROUD_URL, ONECLAW_BASE_URL,
 *   NATIVE_AGENT_TOOLS (default "1"), NATIVE_AGENT_MEMORY (default "1")
 */

"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { URL } = require("url");
const {
  acceptRefreshedAgentToken,
  apiAuthHeaders,
  getAgentToken,
} = require("./agent-token.js");
const {
  getAvailableTools,
  mergeToolDefinitions,
  findDuplicateToolNames,
  executeTool: registryExecuteTool,
  buildContext,
  describeAvailableTools,
} = require("./tools/tool-registry.js");
const { formatApiError } = require("./tools/api-error.js");
const { build1ClawCapabilitiesPrompt } = require("./1claw-capabilities-prompt.js");
const { finalizeAssistantContent, supplementMissingImageGeneration } = require("./generated-image-cache.js");
const {
  sanitizeMessagesForLlm,
  sanitizeToolResultContent,
  isPromptTooLongError,
} = require("./message-sanitize.js");

let toolsConfig = {};
try {
  toolsConfig = require("/app/tools-config.js");
} catch { /* no template config */ }

const PORT = Number(process.env.PORT || process.env.USER_PORT || 8000);
const FRAMEWORK = process.env.ONECLAW_FRAMEWORK || "hermes";
const AGENT_ID = process.env.ONECLAW_AGENT_ID || "";
const RUNTIME_ID = process.env.ONECLAW_RUNTIME_ID || "";
const VAULT_ID = process.env.ONECLAW_VAULT_ID || "";
const BASE_URL =
  process.env.ONECLAW_VAULT_INTERNAL_URL ||
  process.env.ONECLAW_BASE_URL ||
  process.env.ONECLAW_API_URL ||
  "https://api.1claw.co";
const MCP_URL = process.env.ONECLAW_MCP_URL || "https://mcp.1claw.co/mcp";
const TOOLS_ENABLED = process.env.NATIVE_AGENT_TOOLS !== "0";
const MEMORY_ENABLED = process.env.NATIVE_AGENT_MEMORY !== "0";
// LLM_PROVIDER/LLM_MODEL are the dashboard runtime wizard's field names
// (runtimes/new/page.tsx); ONECLAW_DEFAULT_* is this server's older name for
// the same thing. Accept both so the wizard's fields aren't silently ignored.
const DEFAULT_LLM_PROVIDER = process.env.LLM_PROVIDER || process.env.ONECLAW_DEFAULT_PROVIDER || "openai";
const DEFAULT_LLM_MODEL = process.env.LLM_MODEL || process.env.ONECLAW_DEFAULT_MODEL || "gpt-4o-mini";
const MAX_TOOL_ROUNDS = Number(process.env.NATIVE_AGENT_MAX_ROUNDS || "10");

const SHROUD_ENABLED =
  process.env.ONECLAW_SHROUD_ENABLED === "1" ||
  process.env.ONECLAW_SHROUD_ENABLED === "true";

let perRequestLlmApiKey = null;
let agentName = process.env.ONECLAW_AGENT_NAME || null;
let agentDescription = process.env.ONECLAW_AGENT_DESCRIPTION || null;
let runtimeName = process.env.ONECLAW_RUNTIME_NAME || null;

// ---------- Proxy-to-native chat backend ----------
//
// Some frameworks ship their own OpenAI-compatible `/v1/chat/completions`
// (OpenClaw's `openclaw gateway`, and — later — Hermes). When one is present
// and healthy we can proxy the dashboard chat straight to it ("native" mode)
// instead of running this server's own agent loop ("bridge" mode). The bridge
// is always the safety net: a not-yet-rebuilt image, a disabled gateway, or an
// unreachable/erroring native endpoint all transparently fall back to it.
//
// New native frameworks are added by extending `nativeBackendConfig` — no other
// change to this file. Hermes is wired purely by env (ONECLAW_HERMES_NATIVE_URL)
// so a sibling adapter can enable it without touching the bridge.
const HOME_DIR = process.env.HOME || os.homedir();

function defaultOpenclawTokenFile() {
  const dir = process.env.OPENCLAW_CONFIG_DIR || path.join(HOME_DIR, ".openclaw");
  return path.join(dir, "gateway-loopback-token");
}

// Loopback auth token for the OpenClaw gateway. Prefer an explicit env var;
// otherwise read the file openclaw-runtime-setup.js persists (the two processes
// don't share an env, so the file is the handoff). Empty is fine — a gateway
// started with `--allow-unconfigured --bind loopback` may not require one.
function resolveOpenclawToken() {
  const envTok = process.env.ONECLAW_OPENCLAW_NATIVE_TOKEN;
  if (envTok && envTok.trim()) return envTok.trim();
  const file = process.env.ONECLAW_OPENCLAW_TOKEN_FILE || defaultOpenclawTokenFile();
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t) return t;
  } catch { /* no token file yet */ }
  return "";
}

function defaultHermesTokenFile() {
  const dir =
    process.env.HERMES_CONFIG_DIR ||
    process.env.HERMES_HOME ||
    path.join(HOME_DIR, ".hermes");
  return path.join(dir, "native-loopback-token");
}

// Loopback auth token for the in-container Hermes adapter (1claw-hermes's
// OpenAI-compatible SSE adapter on :8778). Same handoff shape as OpenClaw:
// prefer an explicit env var, otherwise read the 0600 file the hermes start
// script provisions (the adapter and this bridge run in separate processes and
// don't share an env). Empty is fine — the adapter treats an unset token as
// "auth disabled".
function resolveHermesToken() {
  const envTok = process.env.ONECLAW_HERMES_NATIVE_TOKEN;
  if (envTok && envTok.trim()) return envTok.trim();
  const file = process.env.ONECLAW_HERMES_TOKEN_FILE || defaultHermesTokenFile();
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t) return t;
  } catch { /* no token file yet */ }
  return "";
}

// Normalise a native gateway base URL to its OpenAI chat-completions endpoint.
// The 1claw-hermes adapter listens on `POST /v1/chat/completions`, but its
// documented wiring env is the OpenAI-style base `.../v1` — accept either (and
// a bare host) so the value the start script exports and the value proxied
// against never drift. Mirrors resolveLlmUpstream's OPENAI_BASE_URL handling.
function toChatCompletionsUrl(base) {
  const b = String(base || "").trim().replace(/\/+$/, "");
  if (!b) return b;
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/v1$/.test(b)) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}

// Returns a native backend descriptor for the given template, or null when the
// template has no native gateway configured (→ serve via the bridge).
function nativeBackendConfig(template) {
  const t = String(template || FRAMEWORK || "").toLowerCase();
  if (t === "openclaw") {
    return {
      name: "openclaw",
      url: process.env.ONECLAW_OPENCLAW_NATIVE_URL || "http://127.0.0.1:18789/v1/chat/completions",
      token: resolveOpenclawToken(),
    };
  }
  // Hermes ships the 1claw-hermes OpenAI-compatible adapter on loopback :8778
  // (launched by hermes-agent-start.sh alongside `hermes gateway`). Native is the
  // default, exactly like OpenClaw — the reachability probe in
  // handleChatCompletions/health is what makes this safe: an image built before
  // the adapter shipped (or an adapter that failed to start) simply fails the
  // probe and transparently falls back to the bridge. ONECLAW_HERMES_NATIVE_URL
  // overrides the endpoint; the token comes from env or the start script's 0600
  // token file (resolveHermesToken).
  if (t === "hermes") {
    return {
      name: "hermes",
      url: toChatCompletionsUrl(
        process.env.ONECLAW_HERMES_NATIVE_URL || "http://127.0.0.1:8778/v1/chat/completions"
      ),
      token: resolveHermesToken(),
    };
  }
  return null;
}

// Priority order: (a) explicit per-turn `body.backend` override, (b) the
// template's native default, (c) bridge. `template` falls back to FRAMEWORK.
function resolveChatBackend(body) {
  const override = typeof body?.backend === "string" ? body.backend.trim().toLowerCase() : "";
  const native = nativeBackendConfig(body?.template);

  if (override === "bridge") return { kind: "bridge", reason: "override" };
  if (override === "native") {
    return native
      ? { kind: "native", config: native, reason: "override" }
      : { kind: "bridge", reason: "override_no_native" };
  }
  // No override — template-derived default.
  if (native) return { kind: "native", config: native, reason: "template_default" };
  return { kind: "bridge", reason: "default" };
}

// Cheap reachability probe: any HTTP status back (even 4xx/405 from a GET on a
// POST-only route) means the port is listening; a connect error/timeout means
// it isn't. Kept short so it never stalls a chat turn or a /health poll.
function probeUrlReachable(targetUrl, token, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(targetUrl); } catch { return resolve(false); }
    const lib = u.protocol === "https:" ? https : http;
    const opts = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
      timeout: timeoutMs,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    };
    const req = lib.request(opts, (resp) => { resp.resume(); resolve(true); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Proxy a chat request to a native gateway. OpenClaw is already OpenAI-shaped —
// we forward the body verbatim (minus 1Claw-only routing/context keys the
// gateway doesn't understand) and stream the SSE through unchanged.
//
// Returns { served: true } once a 2xx response has been (or is being) relayed.
// Returns { served: false } — leaving the response untouched so the caller can
// fall back to the bridge — when the gateway is unreachable or answers non-2xx
// (e.g. a disabled endpoint 404 or an auth 401), provided nothing was written.
const NATIVE_PASSTHROUGH_STRIP_KEYS = new Set([
  "backend", "template", "agent_name", "agent_description", "runtime_name",
  "memory_enabled", "memory_context", "use_own_key", "system_prompt_override",
  "provider",
]);

function buildNativePayload(body) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (NATIVE_PASSTHROUGH_STRIP_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function proxyToNative(config, body, res, wantStream) {
  const payload = JSON.stringify(buildNativePayload(body));
  let u;
  try { u = new URL(config.url); } catch { return Promise.resolve({ served: false }); }
  const lib = u.protocol === "https:" ? https : http;
  const headers = {
    "Content-Type": "application/json",
    Accept: wantStream ? "text/event-stream" : "application/json",
    "Content-Length": Buffer.byteLength(payload),
  };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === "https:" ? 443 : 80),
    path: u.pathname + u.search,
    method: "POST",
    headers,
    timeout: 300000,
  };

  return new Promise((resolve) => {
    const req = lib.request(opts, (upstream) => {
      const status = upstream.statusCode || 502;
      // Non-2xx before we've committed anything → fall back to the bridge.
      if (status < 200 || status >= 300) {
        upstream.resume();
        resolve({ served: false, status });
        return;
      }
      const ct = upstream.headers["content-type"] ||
        (wantStream ? "text/event-stream" : "application/json");
      res.writeHead(status, {
        "Content-Type": ct,
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-1Claw-Chat-Mode": "native",
        "X-1Claw-Native-Backend": config.name,
      });
      upstream.pipe(res);
      upstream.on("end", () => resolve({ served: true }));
      upstream.on("error", () => { try { res.end(); } catch { /* noop */ } resolve({ served: true }); });
    });
    req.on("error", () => resolve({ served: false }));
    req.on("timeout", () => { req.destroy(); resolve({ served: false }); });
    req.write(payload);
    req.end();
  });
}

// Tool-call arguments can carry secret material (put_secret's `value`, etc.)
// — only these keys are ever echoed into a tool_call event or persisted
// summary; everything else is redacted. Mirrors chat-bridge.js.
const SAFE_TOOL_ARG_KEYS = new Set([
  "path", "prefix", "name", "automation_id", "trigger_type", "description", "query",
]);
function redactToolArgs(args) {
  if (!args || typeof args !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] =
      SAFE_TOOL_ARG_KEYS.has(k) && ["string", "number", "boolean"].includes(typeof v)
        ? v
        : "<hidden>";
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Simulated token-by-token reveal for text already fully resolved by the
 * agent loop — see chat-bridge.js's streamTextInChunks for why this is the
 * pragmatic middle ground rather than real streaming through an active
 * tool round-trip. */
async function streamTextInChunks(res, text, model, chunkId) {
  const pieces = text.match(/\s*\S+\s*/g) || [text];
  for (let i = 0; i < pieces.length; i += 3) {
    const piece = pieces.slice(i, i + 3).join("");
    const chunk = {
      id: chunkId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    await sleep(16);
  }
}

// ---------- MCP Tool Definitions (subset for agent loop) ----------

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "get_secret",
      description: "Read a secret from the 1Claw vault",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Secret path in the vault" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "put_secret",
      description: "Store or update a secret in the 1Claw vault",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Secret path" },
          value: { type: "string", description: "Secret value to store" },
        },
        required: ["path", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_secrets",
      description: "List secrets in the vault, optionally filtered by prefix",
      parameters: {
        type: "object",
        properties: {
          prefix: { type: "string", description: "Optional path prefix filter" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_automation",
      description:
        "Create a simple automation for this agent from chat (manual or webhook trigger). " +
        "Allowed steps: log, notify, memory_get, memory_put, wait (max 10). " +
        "Use for reminders, notifications, and lightweight workflows — do NOT redirect users to the dashboard for these. " +
        "For cron, swap, http, or transaction steps, use request_approval instead.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short automation name" },
          trigger_type: { type: "string", enum: ["manual", "webhook"], default: "manual" },
          workflow_spec: {
            type: "object",
            description: "Workflow with steps array. Allowed step types: log, notify, memory_get, memory_put, wait (max 10 steps).",
            properties: {
              steps: {
                type: "array",
                items: { type: "object" },
              },
            },
            required: ["steps"],
          },
          auto_trigger: {
            type: "boolean",
            description: "When true (manual trigger only), start the run immediately after creation",
            default: false,
          },
        },
        required: ["name", "workflow_spec"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_automations",
      description:
        "List automations configured for this agent. When empty, offer create_test_automation or create_automation to set up a first workflow.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "create_test_automation",
      description:
        "Create and immediately run a safe test automation (manual trigger, single log step: 'Automation test successful'). " +
        "Use when the user wants to verify automations work or when list_automations returns none.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "trigger_automation",
      description:
        "Manually trigger an automation by ID. Use after list_automations to run manual workflows on demand.",
      parameters: {
        type: "object",
        properties: {
          automation_id: { type: "string", description: "Automation UUID to trigger" },
        },
        required: ["automation_id"],
      },
    },
  },
];

// ---------- Registry Tools (memory, image, web search, file handler, etc.) ----------

const { definitions: registryDefs, modules: registryModules } = getAvailableTools(process.env, toolsConfig);

// Hardcoded vault/MCP tools take priority over registry equivalents (e.g. list_secrets).
const ALL_TOOL_DEFINITIONS = mergeToolDefinitions(TOOL_DEFINITIONS, registryDefs);
const _toolDupes = findDuplicateToolNames([...TOOL_DEFINITIONS, ...registryDefs]);
if (_toolDupes.length) {
  console.warn(
    `[native-agent] removed duplicate tool definitions before LLM send: ${_toolDupes.join(", ")}`
  );
}

// ---------- Tool Execution via Vault API ----------

async function httpRequest(url, method, headers, body) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === "https:" ? 443 : 80),
    path: u.pathname + u.search,
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    timeout: 30000,
  };
  const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null;
  if (bodyBuf) opts.headers["Content-Length"] = bodyBuf.length;

  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (resp) => {
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: resp.statusCode, text, headers: resp.headers });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function authHeaders() {
  return apiAuthHeaders();
}

async function executeTool(name, args) {
  const token = getAgentToken();
  if (!token) return { error: "No agent token available for tool execution" };

  try {
    switch (name) {
      case "get_secret": {
        const resp = await httpRequest(
          `${BASE_URL}/v1/vaults/${VAULT_ID}/secrets/${encodeURIComponent(args.path)}`,
          "GET", authHeaders(), null
        );
        if (resp.status !== 200) return formatApiError(resp.status, resp.text, "get_secret");
        const data = JSON.parse(resp.text);
        return { value: data.value, type: data.secret_type, version: data.version };
      }
      case "put_secret": {
        const resp = await httpRequest(
          `${BASE_URL}/v1/vaults/${VAULT_ID}/secrets/${encodeURIComponent(args.path)}`,
          "PUT", authHeaders(), { value: args.value }
        );
        if (resp.status !== 200 && resp.status !== 201)
          return formatApiError(resp.status, resp.text, "put_secret");
        return { success: true, path: args.path };
      }
      case "list_secrets": {
        const prefix = args.prefix ? `?prefix=${encodeURIComponent(args.prefix)}` : "";
        const resp = await httpRequest(
          `${BASE_URL}/v1/vaults/${VAULT_ID}/secrets${prefix}`,
          "GET", authHeaders(), null
        );
        if (resp.status !== 200) return formatApiError(resp.status, resp.text, "list_secrets");
        return JSON.parse(resp.text);
      }
      case "list_automations": {
        const resp = await httpRequest(
          `${BASE_URL}/v1/automations?agent_id=${AGENT_ID}`,
          "GET", authHeaders(), null
        );
        if (resp.status !== 200) return formatApiError(resp.status, resp.text, "list_automations");
        const data = JSON.parse(resp.text);
        const automations = data.automations || [];
        if (automations.length === 0) {
          return {
            ...data,
            automations: [],
            hint:
              "No automations yet. Offer create_test_automation for a quick verification ping, " +
              "or create_automation to build a simple manual/webhook workflow (log, notify, memory, wait steps).",
          };
        }
        return data;
      }
      case "create_test_automation": {
        const body = {
          name: `Chat test ping ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
          trigger_type: "manual",
          workflow_spec: {
            steps: [{ type: "log", params: { message: "Automation test successful" } }],
          },
          auto_trigger: true,
        };
        const resp = await httpRequest(
          `${BASE_URL}/v1/agents/${AGENT_ID}/automations`,
          "POST", authHeaders(), body
        );
        if (resp.status !== 201) return formatApiError(resp.status, resp.text, "create_test_automation");
        const result = JSON.parse(resp.text);
        return {
          ...result,
          message: "Test automation created and triggered. Check run status in the dashboard or list_automations.",
        };
      }
      case "create_automation": {
        const body = {
          name: args.name,
          trigger_type: args.trigger_type || "manual",
          workflow_spec: args.workflow_spec,
          auto_trigger: Boolean(args.auto_trigger),
        };
        const resp = await httpRequest(
          `${BASE_URL}/v1/agents/${AGENT_ID}/automations`,
          "POST", authHeaders(), body
        );
        if (resp.status !== 201) return formatApiError(resp.status, resp.text, "create_automation");
        return JSON.parse(resp.text);
      }
      case "trigger_automation": {
        const resp = await httpRequest(
          `${BASE_URL}/v1/automations/${args.automation_id}/trigger`,
          "POST", authHeaders(), {}
        );
        if (resp.status !== 200 && resp.status !== 201)
          return formatApiError(resp.status, resp.text, "trigger_automation");
        return JSON.parse(resp.text);
      }
      default: {
        const ctx = buildContext({ agentToken: getAgentToken() });
        return registryExecuteTool(name, args, ctx, registryModules);
      }
    }
  } catch (e) {
    return { error: `Tool execution error: ${e.message}` };
  }
}

// ---------- LLM Upstream ----------

function resolveLlmUpstream(provider, useOwnKey) {
  const PROVIDER_BASE_URLS = {
    openai: "https://api.openai.com",
    anthropic: "https://api.anthropic.com",
    google: "https://generativelanguage.googleapis.com",
    mistral: "https://api.mistral.ai",
    cohere: "https://api.cohere.com",
  };

  if (useOwnKey && provider && PROVIDER_BASE_URLS[provider]) {
    return { url: `${PROVIDER_BASE_URLS[provider]}/v1/chat/completions`, via: `direct-${provider}` };
  }
  if (SHROUD_ENABLED) {
    return { url: "http://127.0.0.1:8082/v1/chat/completions", via: "sidecar" };
  }
  const openaiBase = (process.env.OPENAI_BASE_URL || "").replace(/\/$/, "");
  if (openaiBase) {
    const path = openaiBase.endsWith("/v1")
      ? `${openaiBase}/chat/completions`
      : `${openaiBase}/v1/chat/completions`;
    return { url: path, via: "openai_base_url" };
  }
  const shroud = (process.env.ONECLAW_SHROUD_URL || "https://shroud.1claw.co").replace(/\/$/, "");
  return { url: `${shroud}/v1/chat/completions`, via: "shroud" };
}

function resolveMaxTokens(body) {
  const fromBody = body?.max_tokens;
  if (typeof fromBody === "number" && fromBody > 0) return fromBody;
  if (typeof fromBody === "string" && fromBody.trim()) {
    const parsed = Number(fromBody);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const fromEnv = Number(process.env.NATIVE_AGENT_MAX_TOKENS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 4096;
}

function buildLlmHeaders(provider) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (perRequestLlmApiKey) {
    headers.Authorization = `Bearer ${perRequestLlmApiKey}`;
    if (provider) headers["X-Shroud-Provider"] = provider;
    return headers;
  }
  const token = getAgentToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    const apiKey = process.env.ONECLAW_AGENT_API_KEY || "";
    if (AGENT_ID && apiKey && !apiKey.startsWith("eyJ")) {
      headers["X-Shroud-Agent-Key"] = `${AGENT_ID}:${apiKey}`;
    }
  }
  if (provider) headers["X-Shroud-Provider"] = provider;
  return headers;
}

async function callLlm(messages, model, provider, useOwnKey, stream, maxTokens, disableTools = false) {
  const upstream = resolveLlmUpstream(provider, useOwnKey);
  const sendTools = TOOLS_ENABLED && !disableTools;
  const safeMessages = sanitizeMessagesForLlm(messages);
  const payload = JSON.stringify({
    model,
    messages: safeMessages,
    stream: false,
    max_tokens: maxTokens,
    tools: sendTools ? mergeToolDefinitions(ALL_TOOL_DEFINITIONS) : undefined,
    tool_choice: sendTools ? "auto" : undefined,
  });

  // Raw proxy (not httpRequest) so we control the JSON body sent to the LLM
  // directly, rather than httpRequest's own JSON-wrapping.
  const u = new URL(upstream.url);
  const lib = u.protocol === "https:" ? https : http;
  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === "https:" ? 443 : 80),
    path: u.pathname + u.search,
    method: "POST",
    headers: {
      ...buildLlmHeaders(provider),
      "Content-Length": Buffer.byteLength(payload),
    },
    timeout: 120000,
  };

  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (resp) => {
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (resp.statusCode >= 400) {
          reject(new Error(`LLM returned ${resp.statusCode}: ${text.slice(0, 500)}`));
          return;
        }
        try { resolve(JSON.parse(text)); }
        catch { reject(new Error(`Invalid LLM response: ${text.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("LLM timeout")); });
    req.write(payload);
    req.end();
  });
}

async function callLlmStreaming(messages, model, provider, useOwnKey, maxTokens) {
  const upstream = resolveLlmUpstream(provider, useOwnKey);
  const safeMessages = sanitizeMessagesForLlm(messages);
  const payload = JSON.stringify({
    model,
    messages: safeMessages,
    stream: true,
    max_tokens: maxTokens,
    tools: TOOLS_ENABLED ? mergeToolDefinitions(ALL_TOOL_DEFINITIONS) : undefined,
    tool_choice: TOOLS_ENABLED ? "auto" : undefined,
    // Real token counts on the final SSE chunk, via Shroud/sidecar only —
    // left off for a raw BYOK call straight to a provider's native API.
    // (This function only runs when TOOLS_ENABLED is false, so the tools
    // fields above are always undefined here in practice.)
    ...(!useOwnKey ? { stream_options: { include_usage: true } } : {}),
  });

  const u = new URL(upstream.url);
  const lib = u.protocol === "https:" ? https : http;
  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === "https:" ? 443 : 80),
    path: u.pathname + u.search,
    method: "POST",
    headers: {
      ...buildLlmHeaders(provider),
      "Content-Length": Buffer.byteLength(payload),
    },
    timeout: 300000,
  };

  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (resp) => resolve(resp));
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("LLM stream timeout")); });
    req.write(payload);
    req.end();
  });
}

// ---------- Agent Loop (non-streaming with tool calls) ----------

async function agentLoop(messages, model, provider, useOwnKey, maxTokens, onEvent) {
  let conversationMessages = [...messages];
  let rounds = 0;
  let toolsDisabledFallback = false;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  const toolCallsSummary = [];

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds++;
    let response;
    try {
      response = await callLlm(conversationMessages, model, provider, useOwnKey, false, maxTokens, toolsDisabledFallback);
    } catch (e) {
      // If the LLM rejects our tools (e.g. Anthropic "Tool names must be unique"),
      // retry once without tools so the user still gets a response.
      if (rounds === 1 && !toolsDisabledFallback && isToolSchemaError(e)) {
        console.error(`[native-agent] tool schema rejected by ${provider}, retrying without tools:`, e.message);
        toolsDisabledFallback = true;
        rounds--;
        continue;
      }
      if (isPromptTooLongError(e.message)) {
        throw new Error(
          `LLM context too large (${e.message.slice(0, 200)}). ` +
          "Start a new chat conversation — prior inline images in history can inflate the prompt. " +
          "If this persists on a fresh chat, Stop and Start the runtime to pick up the latest image-gen fix."
        );
      }
      throw e;
    }

    if (response.usage) {
      // Each round is a separate billed API call — summing (not deduping
      // the resent context) matches the actual dollar cost of this turn.
      totalPromptTokens += response.usage.prompt_tokens || 0;
      totalCompletionTokens += response.usage.completion_tokens || 0;
    }

    const choice = response?.choices?.[0];
    if (!choice) throw new Error("No choices in LLM response");

    const msg = choice.message;
    conversationMessages.push(msg);

    if (choice.finish_reason !== "tool_calls" || !msg.tool_calls || msg.tool_calls.length === 0) {
      await supplementMissingImageGeneration(conversationMessages, executeTool, {
        enabled: TOOLS_ENABLED && registryModules.has("generate_image"),
      });
      const content = finalizeAssistantContent(msg.content || "", conversationMessages);
      const toolNote = toolsDisabledFallback
        ? "\n\n---\n*Note: Tools were temporarily unavailable for this response due to a provider compatibility issue. Try again, or switch to a different LLM provider in your agent settings if this persists.*"
        : "";
      return {
        content: content + toolNote,
        tool_calls_made: rounds - 1,
        tools_fallback: toolsDisabledFallback,
        usage: { prompt_tokens: totalPromptTokens, completion_tokens: totalCompletionTokens },
        tool_calls_summary: toolCallsSummary,
      };
    }

    for (const tc of msg.tool_calls) {
      let args = {};
      try {
        args = typeof tc.function.arguments === "string"
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments || {};
      } catch { /* keep empty args */ }

      const safeArgs = redactToolArgs(args);
      onEvent?.({ id: tc.id, name: tc.function?.name, arguments: safeArgs, status: "started", round: rounds });

      const result = await executeTool(tc.function.name, args);
      const status = result && typeof result === "object" && result.error ? "error" : "completed";

      onEvent?.({ id: tc.id, name: tc.function?.name, status, round: rounds });
      toolCallsSummary.push({ id: tc.id, name: tc.function?.name, arguments: safeArgs, status });

      conversationMessages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: sanitizeToolResultContent(result),
      });
    }
  }

  return {
    content: "(Agent loop exceeded maximum tool rounds)",
    tool_calls_made: rounds,
    usage: { prompt_tokens: totalPromptTokens, completion_tokens: totalCompletionTokens },
    tool_calls_summary: toolCallsSummary,
  };
}

function isToolSchemaError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("tool names must be unique")
    || msg.includes("duplicate tool")
    || (msg.includes("tools") && msg.includes("invalid_request_error"));
}

// ---------- System prompt ----------

function buildSystemPrompt(opts = {}) {
  const { memoryEnabled = false, memoryContext = null, model = null, provider = null } = opts;
  const fw = FRAMEWORK === "hermes" ? "Hermes" : FRAMEWORK === "openclaw" ? "OpenClaw" : FRAMEWORK;
  // AGENT_SYSTEM_PROMPT is the dashboard runtime wizard's "System Prompt" field
  // (dashboard/src/app/(authenticated)/runtimes/new/page.tsx) — a user-defined
  // persona that replaces the generated identity line. Everything else below
  // (capabilities, tool list, memory) still gets appended so a custom persona
  // doesn't lose awareness of what it can actually do.
  const customPersona = (process.env.AGENT_SYSTEM_PROMPT || "").trim();
  const identity = customPersona
    ? customPersona
    : agentName
      ? `You are "${agentName}" (${fw}), an AI agent running in a 1Claw cloud runtime with native tool access.`
      : `You are ${fw}, an AI agent running in a 1Claw cloud runtime (native mode) with full tool access.`;

  const effectiveModel = model || DEFAULT_LLM_MODEL;
  const effectiveProvider = provider || DEFAULT_LLM_PROVIDER;
  const modelLine = `You are currently running on ${effectiveModel} via ${effectiveProvider}.`;

  const parts = [
    identity,
    modelLine,
    agentDescription ? `Your purpose: ${agentDescription}` : null,
    runtimeName ? `Runtime: ${runtimeName}.` : null,
    AGENT_ID ? `Agent ID: ${AGENT_ID}.` : null,
    "You have NATIVE access to 1Claw tools — you can read/write vault secrets, list signing keys (ETH/XRP addresses), use agent memory, create simple automations, trigger workflows, and more.",
    "When the user asks you to remember something, store it in durable memory using put_memory or remember.",
    "When you need credentials or secrets, use get_secret instead of asking the user to paste them.",
    "When the user asks for wallet addresses or signing keys, use list_signing_keys — not list_secrets or agent_keys/ paths.",
    build1ClawCapabilitiesPrompt(),
    TOOLS_ENABLED
      ? (() => {
          const vaultToolNames = TOOL_DEFINITIONS.map((t) => t.function?.name).filter(Boolean);
          const registryDesc = describeAvailableTools(registryModules);
          return `Vault tools: ${vaultToolNames.join(", ")}. ${registryDesc}`;
        })()
      : "Tools are disabled for this session.",
    TOOLS_ENABLED && registryModules.has("generate_image")
      ? "When you generate an image with generate_image, include the returned URL in your reply as markdown: ![description](url)."
      : null,
    memoryEnabled
      ? "Agent memory is enabled — facts and goals persist across sessions."
      : null,
    memoryContext
      ? `\n## Stored memory (from 1Claw durable memory)\n${memoryContext}`
      : memoryEnabled
        ? "\n## Stored memory\n(No prior memories yet.)"
        : null,
    "When something isn't working (e.g. image generation, memory, tools), explain what the user needs to configure and where to find it in their 1Claw dashboard — never suggest they contact the 1Claw team or wait for someone else to set it up.",
  ];

  return parts.filter(Boolean).join("\n");
}

// ---------- Request Handling ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function handleChatCompletions(req, res) {
  let raw;
  try { raw = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: { message: e.message || "bad body" } }); }

  let body;
  try { body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; }
  catch { return sendJson(res, 400, { error: { message: "Invalid JSON body" } }); }

  // Hot-swap agent token
  acceptRefreshedAgentToken(req.headers["x-refreshed-agent-token"]);

  // Per-request LLM API key
  const llmApiKey = req.headers["x-llm-api-key"];
  perRequestLlmApiKey = (llmApiKey && typeof llmApiKey === "string" && llmApiKey.length > 0)
    ? llmApiKey : null;

  // Proxy-to-native routing. When the resolved backend is a framework's own
  // OpenAI-compatible gateway AND it's reachable, stream straight through to it
  // ("native"). Any failure — unreachable, disabled endpoint, non-2xx — falls
  // back to the bridge path below with nothing written to `res`.
  const backend = resolveChatBackend(body);
  if (backend.kind === "native" && backend.config) {
    const reachable = await probeUrlReachable(backend.config.url, backend.config.token);
    if (reachable) {
      const outcome = await proxyToNative(backend.config, body, res, Boolean(body.stream));
      if (outcome.served) return;
      console.warn(
        `[native-agent] native backend '${backend.config.name}' returned ${outcome.status || "unreachable"} — falling back to bridge`
      );
    } else {
      console.warn(
        `[native-agent] native backend '${backend.config.name}' unreachable at ${backend.config.url} — falling back to bridge`
      );
    }
    // fall through to bridge (nothing written to res yet)
  }

  // Agent identity
  if (body.agent_name) agentName = body.agent_name;
  if (body.agent_description) agentDescription = body.agent_description;
  if (body.runtime_name) runtimeName = body.runtime_name;

  const messages = sanitizeMessagesForLlm(
    Array.isArray(body.messages) ? [...body.messages] : []
  );
  const memoryEnabled = Boolean(body.memory_enabled) || MEMORY_ENABLED;
  const memoryContext = (typeof body.memory_context === "string" && body.memory_context.trim())
    ? body.memory_context.trim() : null;

  const model = body.model || DEFAULT_LLM_MODEL;
  const provider = body.provider || DEFAULT_LLM_PROVIDER;

  if (!messages.some((m) => m && m.role === "system")) {
    const promptContent = body.system_prompt_override || buildSystemPrompt({ memoryEnabled, memoryContext, model, provider });
    messages.unshift({ role: "system", content: promptContent });
  } else if (memoryContext) {
    const sysIdx = messages.findIndex((m) => m && m.role === "system");
    if (sysIdx >= 0 && typeof messages[sysIdx].content === "string") {
      messages[sysIdx] = {
        ...messages[sysIdx],
        content: `${messages[sysIdx].content}\n\n## Stored memory (from 1Claw)\n${memoryContext}`,
      };
    }
  }

  const stream = Boolean(body.stream);
  const useOwnKey = Boolean(body.use_own_key) || !!perRequestLlmApiKey;
  const maxTokens = resolveMaxTokens(body);

  if (stream && TOOLS_ENABLED) {
    const chatId = `chatcmpl-native-${Date.now()}`;
    // Headers open before the agent loop runs (not after) so tool_call
    // events can be written live as each round executes, instead of the
    // whole loop resolving silently behind a blank spinner first.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // The 1Claw bridge (this server's own tool-enabled agent loop) served the
      // turn — "native" is reserved for a proxy to a framework's own gateway.
      "X-1Claw-Chat-Mode": "bridge",
    });
    const onEvent = (ev) => res.write(`data: ${JSON.stringify({ tool_call: ev })}\n\n`);

    try {
      const result = await agentLoop(messages, model, provider, useOwnKey, maxTokens, onEvent);

      await streamTextInChunks(res, result.content, model, chatId);

      const usageChunk = {
        id: chatId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [],
        usage: {
          prompt_tokens: result.usage?.prompt_tokens || 0,
          completion_tokens: result.usage?.completion_tokens || 0,
          total_tokens: (result.usage?.prompt_tokens || 0) + (result.usage?.completion_tokens || 0),
        },
      };
      res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);

      const done = {
        id: chatId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
      res.write(`data: ${JSON.stringify(done)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (e) {
      console.error("[native-agent] agent loop error:", e.message);
      // Headers are already committed to SSE (200) at this point — end the
      // stream with a visible error chunk rather than hanging the client.
      res.write(`data: ${JSON.stringify({ error: { message: `Agent loop failed: ${e.message}` } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
    return;
  }

  if (stream && !TOOLS_ENABLED) {
    // Pure streaming passthrough (no tools) — same as chat-bridge
    try {
      const upstreamResp = await callLlmStreaming(messages, model, provider, useOwnKey, maxTokens);
      res.writeHead(upstreamResp.statusCode || 502, {
        "Content-Type": upstreamResp.headers["content-type"] || "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-1Claw-Chat-Mode": "bridge",
      });
      upstreamResp.pipe(res);
      upstreamResp.on("error", () => res.end());
    } catch (e) {
      return sendJson(res, 502, { error: { message: `LLM upstream unavailable: ${e.message}` } });
    }
    return;
  }

  // Non-streaming with agent loop
  try {
    const result = await agentLoop(messages, model, provider, useOwnKey, maxTokens);
    sendJson(res, 200, {
      id: `chatcmpl-native-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: result.content },
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: result.usage?.prompt_tokens || 0,
        completion_tokens: result.usage?.completion_tokens || 0,
        total_tokens: (result.usage?.prompt_tokens || 0) + (result.usage?.completion_tokens || 0),
        tool_calls_made: result.tool_calls_made,
      },
      tool_calls_summary: result.tool_calls_summary,
    });
  } catch (e) {
    console.error("[native-agent] error:", e.message);
    sendJson(res, 502, { error: { message: `Agent error: ${e.message}` } });
  }
}

// ---------- Server ----------

const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  const method = req.method || "GET";

  if (method === "GET" && (url === "/health" || url === "/healthz")) {
    // Advertise which native gateways (if any) are reachable so operators can
    // see whether this runtime will proxy chat to a framework's own agent
    // ("native") or serve it via this bridge ("bridge"). Probe is short so a
    // /health poll never stalls.
    const fwNative = nativeBackendConfig(FRAMEWORK);
    const nativeBackends = {};
    if (fwNative) {
      nativeBackends[fwNative.name] = await probeUrlReachable(fwNative.url, fwNative.token, 700);
    }
    const defaultBackend = fwNative && nativeBackends[fwNative.name] ? "native" : "bridge";
    return sendJson(res, 200, {
      status: "ok",
      framework: FRAMEWORK,
      chat: true,
      // Truthful default for this runtime given current reachability; a per-turn
      // `backend` override can still force the other path.
      mode: defaultBackend,
      default_chat_backend: defaultBackend,
      native_backends: nativeBackends,
      tools_enabled: TOOLS_ENABLED,
      memory_enabled: MEMORY_ENABLED,
      agent_id: AGENT_ID || null,
      runtime_id: RUNTIME_ID || null,
      available_tools: TOOLS_ENABLED
        ? ALL_TOOL_DEFINITIONS.map((t) => t.function?.name).filter(Boolean)
        : [],
    });
  }

  if (method === "POST" && url === "/v1/chat/completions") {
    try {
      return await handleChatCompletions(req, res);
    } catch (e) {
      console.error("[native-agent] handler error:", e);
      if (!res.headersSent) return sendJson(res, 500, { error: { message: "internal error" } });
      return;
    }
  }

  sendJson(res, 404, {
    error: {
      message: `not found: ${method} ${url}`,
      hint: "Supported: GET /health, POST /v1/chat/completions",
    },
  });
});

server.on("error", (err) => {
  console.error("[native-agent] listen error:", err.message);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  const upstream = resolveLlmUpstream(DEFAULT_LLM_PROVIDER, false);
  console.log(
    `1claw native-agent-server (${FRAMEWORK}) on 127.0.0.1:${PORT} → ${upstream.url} (${upstream.via}) [tools=${TOOLS_ENABLED}, memory=${MEMORY_ENABLED}]`
  );
});
