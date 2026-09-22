#!/usr/bin/env node
/**
 * 1Claw runtime chat bridge (pragmatic v1)
 *
 * Exposes OpenAI-compatible chat on USER_PORT (default 8000) so the Vault
 * dashboard can talk to the agent container via POST /v1/runtimes/{id}/chat.
 *
 * This is a bridge, not a full Hermes/OpenClaw packaging:
 *   - GET  /health                  — probe (keeps Cloud Run healthy)
 *   - POST /v1/chat/completions     — OpenAI-compatible; SSE when stream=true
 *
 * LLM upstream (first match):
 *   1. Sidecar LLM proxy at http://127.0.0.1:8082 when Shroud is enabled
 *   2. OPENAI_BASE_URL (…/v1) + /chat/completions
 *   3. ONECLAW_SHROUD_URL + /v1/chat/completions
 *
 * Auth to this port is enforced by the shroud-sidecar inbound proxy
 * (runtime-chat JWT from Vault). The bridge binds loopback only — external
 * traffic must enter via the sidecar.
 *
 * Env:
 *   PORT / USER_PORT, ONECLAW_FRAMEWORK, ONECLAW_AGENT_ID, ONECLAW_RUNTIME_ID,
 *   ONECLAW_AGENT_TOKEN / ONECLAW_TOKEN, ONECLAW_SHROUD_ENABLED, ONECLAW_SHROUD_URL,
 *   OPENAI_BASE_URL, ONECLAW_DEFAULT_PROVIDER, ONECLAW_DEFAULT_MODEL
 */

"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");
const {
  getAvailableTools,
  mergeToolDefinitions,
  findDuplicateToolNames,
  executeTool,
  buildContext,
  describeAvailableTools,
} = require("./tools/tool-registry.js");
const {
  acceptRefreshedAgentToken,
  getAgentToken,
} = require("./agent-token.js");
const { build1ClawCapabilitiesPrompt } = require("./1claw-capabilities-prompt.js");
const {
  finalizeAssistantContent,
  supplementMissingImageGeneration,
} = require("./generated-image-cache.js");
const {
  sanitizeMessagesForLlm,
  sanitizeToolResultContent,
  isPromptTooLongError,
} = require("./message-sanitize.js");

const PORT = Number(process.env.PORT || process.env.USER_PORT || 8000);
const FRAMEWORK = process.env.ONECLAW_FRAMEWORK || "runtime";
const AGENT_ID = process.env.ONECLAW_AGENT_ID || "";
const RUNTIME_ID = process.env.ONECLAW_RUNTIME_ID || "";

// Vault sends a fresh agent JWT on each dashboard chat request.
const SHROUD_ENABLED =
  process.env.ONECLAW_SHROUD_ENABLED === "1" ||
  process.env.ONECLAW_SHROUD_ENABLED === "true";
const DEFAULT_PROVIDER = process.env.ONECLAW_DEFAULT_PROVIDER || "openai";
const DEFAULT_MODEL = process.env.ONECLAW_DEFAULT_MODEL || "gpt-4o-mini";
let toolsConfig = {};
try {
  toolsConfig = require("/app/tools-config.js");
} catch { /* no template config */ }

const { definitions: registryToolDefs, modules: toolModules } = getAvailableTools(process.env, toolsConfig);
const TOOL_DEFINITIONS = mergeToolDefinitions(registryToolDefs);
const TOOLS_AVAILABLE = TOOL_DEFINITIONS.length > 0;
const _toolDupes = findDuplicateToolNames(registryToolDefs);
if (_toolDupes.length) {
  console.warn(
    `[chat-bridge] removed duplicate tool definitions before LLM send: ${_toolDupes.join(", ")}`
  );
}
const MAX_TOOL_ROUNDS = 10;

const PROVIDER_BASE_URLS = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
  mistral: "https://api.mistral.ai",
  cohere: "https://api.cohere.com",
};

function resolveUpstream(provider, useOwnKey) {
  // When user provides their own key, go directly to the provider API
  // (bypass Shroud) so their key authenticates natively.
  if (useOwnKey && provider && PROVIDER_BASE_URLS[provider]) {
    return {
      url: `${PROVIDER_BASE_URLS[provider]}/v1/chat/completions`,
      via: `direct-${provider}`,
    };
  }

  // Prefer in-container sidecar LLM proxy (Shroud-routed).
  if (SHROUD_ENABLED) {
    return {
      url: "http://127.0.0.1:8082/v1/chat/completions",
      via: "sidecar",
    };
  }
  const openaiBase = (process.env.OPENAI_BASE_URL || "").replace(/\/$/, "");
  if (openaiBase) {
    const path = openaiBase.endsWith("/v1")
      ? `${openaiBase}/chat/completions`
      : `${openaiBase}/v1/chat/completions`;
    return { url: path, via: "openai_base_url" };
  }
  const shroud = (process.env.ONECLAW_SHROUD_URL || "https://shroud.1claw.co").replace(
    /\/$/,
    ""
  );
  return { url: `${shroud}/v1/chat/completions`, via: "shroud" };
}

// Agent identity — updated per-request from Vault-injected metadata.
let agentName = process.env.ONECLAW_AGENT_NAME || null;
let agentDescription = process.env.ONECLAW_AGENT_DESCRIPTION || null;
let runtimeName = process.env.ONECLAW_RUNTIME_NAME || null;

function frameworkDisplayName() {
  const t = (FRAMEWORK || "").toLowerCase();
  if (t === "hermes") return "Hermes";
  if (t === "openclaw") return "OpenClaw";
  if (t === "openclaude") return "OpenClaude";
  if (t === "opencode") return "OpenCode";
  return FRAMEWORK;
}

function systemPrompt(opts = {}) {
  const { memoryEnabled = false, memoryContext = null, model = null, provider = null } = opts;
  const display = frameworkDisplayName();
  const identity = agentName
    ? `You are "${agentName}" (${display}), an AI agent running inside a 1Claw cloud runtime.`
    : `You are ${display}, an AI agent running inside a 1Claw cloud runtime (${FRAMEWORK} template).`;

  const effectiveModel = model || DEFAULT_MODEL;
  const effectiveProvider = provider || DEFAULT_PROVIDER;
  const modelLine = `You are currently running on ${effectiveModel} via ${effectiveProvider}.`;

  const memoryLines = memoryEnabled
    ? [
        "You have persistent memory via 1Claw's agent memory system — facts and goals you store survive across chat sessions and browser restarts.",
        "When the user shares preferences, goals, or asks you to remember something, confirm that it is stored in durable memory.",
        "Do NOT claim you lack persistent memory. You can recall stored context below and persist new facts from this conversation.",
      ]
    : [
        "Agent memory is not currently enabled. To enable cross-session recall, go to Dashboard → Agents → select this agent → toggle Agent Memory on.",
      ];

  const parts = [
    identity,
    modelLine,
    agentDescription ? `Your purpose: ${agentDescription}` : null,
    runtimeName ? `Runtime: ${runtimeName}.` : null,
    AGENT_ID ? `Agent ID: ${AGENT_ID}.` : null,
    RUNTIME_ID ? `Runtime ID: ${RUNTIME_ID}.` : null,
    ...memoryLines,
    memoryContext
      ? `\n## Stored memory (from 1Claw durable memory — treat as ground truth)\n${memoryContext}`
      : memoryEnabled
        ? "\n## Stored memory\n(No prior memories yet — this is a fresh session.)"
        : null,
    "You have access to the 1Claw CLI and SDK in this container (secrets, vault, MCP tools via shell).",
    TOOLS_AVAILABLE
      ? `You have access to the following tools:\n${describeAvailableTools(toolModules)}\nWhen you generate an image, show it as markdown: ![description](url).`
      : null,
    "When the user asks for wallet addresses or signing keys, use list_signing_keys — not list_secrets or agent_keys/ paths.",
    build1ClawCapabilitiesPrompt(),
    "Be concise and practical. If you need credentials, use 1Claw rather than asking the user to paste secrets.",
    "When something isn't working (e.g. image generation, memory, tools), explain what the user needs to configure and where to find it in their 1Claw dashboard — never suggest they contact the 1Claw team or wait for someone else to set it up.",
  ];

  return parts.filter(Boolean).join("\n");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function proxyRequest(upstreamUrl, headers, bodyBuf, { stream }) {
  const u = new URL(upstreamUrl);
  const lib = u.protocol === "https:" ? https : http;
  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === "https:" ? 443 : 80),
    path: u.pathname + u.search,
    method: "POST",
    headers: {
      ...headers,
      "Content-Length": bodyBuf.length,
      Host: u.host,
    },
    timeout: stream ? 300000 : 120000,
  };
  return new Promise((resolve, reject) => {
    const upstream = lib.request(opts, (resp) => resolve(resp));
    upstream.on("error", reject);
    upstream.on("timeout", () => {
      upstream.destroy();
      reject(new Error("upstream timeout"));
    });
    upstream.write(bodyBuf);
    upstream.end();
  });
}

// Per-request user-supplied LLM API key, set via X-LLM-Api-Key header
// from Vault when the dashboard user chooses "Own API Key".
let perRequestLlmApiKey = null;

function resolveMaxTokens(body) {
  const fromBody = body?.max_tokens;
  if (typeof fromBody === "number" && fromBody > 0) return fromBody;
  if (typeof fromBody === "string" && fromBody.trim()) {
    const parsed = Number(fromBody);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 4096;
}

function buildAuthHeaders(provider) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // When a user-supplied LLM key is active, use it directly for the
  // upstream provider instead of routing through Shroud agent auth.
  if (perRequestLlmApiKey) {
    headers.Authorization = `Bearer ${perRequestLlmApiKey}`;
    if (provider) {
      headers["X-Shroud-Provider"] = provider;
    }
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
  if (provider) {
    headers["X-Shroud-Provider"] = provider;
  }
  return headers;
}

async function callLlmWithTools(messages, model, provider, useOwnKey, maxTokens) {
  if (!TOOLS_AVAILABLE) return null;

  const context = buildContext({ agentToken: getAgentToken() });
  let conversationMessages = [...messages];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const safeMessages = sanitizeMessagesForLlm(conversationMessages);
    const payload = JSON.stringify({
      model,
      messages: safeMessages,
      stream: false,
      max_tokens: maxTokens,
      tools: mergeToolDefinitions(TOOL_DEFINITIONS),
      tool_choice: "auto",
    });

    let upstreamResp;
    try {
      upstreamResp = await proxyRequest(
        resolveUpstream(provider, useOwnKey).url,
        buildAuthHeaders(provider),
        Buffer.from(payload),
        { stream: false }
      );
    } catch {
      return null;
    }

    const chunks = [];
    for await (const c of upstreamResp) chunks.push(c);
    const respBuf = Buffer.concat(chunks);
    if (upstreamResp.statusCode >= 400) {
      // If the provider rejects the tool schema, return null so the bridge
      // falls through to the tool-free passthrough path below.
      const errText = respBuf.toString("utf8").toLowerCase();
      if (errText.includes("tool names must be unique") || errText.includes("duplicate tool")) {
        console.error("[chat-bridge] provider rejected tool schema, falling through to passthrough:", errText.slice(0, 200));
      }
      return null;
    }

    let response;
    try {
      response = JSON.parse(respBuf.toString("utf8"));
    } catch {
      return null;
    }

    const choice = response?.choices?.[0];
    if (!choice) return null;
    const msg = choice.message;
    conversationMessages.push(msg);

    if (choice.finish_reason !== "tool_calls" || !msg.tool_calls?.length) {
      await supplementMissingImageGeneration(
        conversationMessages,
        (name, args) => executeTool(name, args, context, toolModules),
        { enabled: toolModules.has("generate_image") }
      );
      return {
        content: finalizeAssistantContent(msg.content || "", conversationMessages),
        tool_rounds: round,
      };
    }

    for (const tc of msg.tool_calls) {
      let args = {};
      try {
        args = typeof tc.function.arguments === "string"
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments || {};
      } catch { /* empty */ }

      const result = await executeTool(tc.function?.name, args, context, toolModules);

      conversationMessages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: sanitizeToolResultContent(result),
      });
    }
  }

  return { content: "(Tool loop exceeded maximum rounds)", tool_rounds: MAX_TOOL_ROUNDS };
}

async function handleChatCompletions(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: { message: e.message || "bad body" } });
  }

  let body;
  try {
    body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
  } catch {
    return sendJson(res, 400, { error: { message: "Invalid JSON body" } });
  }

  // Hot-swap agent token when Vault sends a fresh one (prevents ExpiredSignature).
  const freshToken = req.headers["x-refreshed-agent-token"];
  acceptRefreshedAgentToken(freshToken);

  // User-supplied LLM API key from vault (per-request, not persisted).
  const llmApiKey = req.headers["x-llm-api-key"];
  perRequestLlmApiKey =
    llmApiKey && typeof llmApiKey === "string" && llmApiKey.length > 0
      ? llmApiKey
      : null;

  // Pick up agent identity from Vault-injected fields for the system prompt.
  if (body.agent_name) agentName = body.agent_name;
  if (body.agent_description) agentDescription = body.agent_description;
  if (body.runtime_name) runtimeName = body.runtime_name;

  const messages = sanitizeMessagesForLlm(
    Array.isArray(body.messages) ? [...body.messages] : []
  );
  const memoryEnabled = Boolean(body.memory_enabled);
  const memoryContext =
    typeof body.memory_context === "string" && body.memory_context.trim()
      ? body.memory_context.trim()
      : null;

  const model = body.model || DEFAULT_MODEL;
  const provider = body.provider || DEFAULT_PROVIDER;

  if (!messages.some((m) => m && m.role === "system")) {
    const promptContent =
      body.system_prompt_override ||
      systemPrompt({ memoryEnabled, memoryContext, model, provider });
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

  if (TOOLS_AVAILABLE) {
    try {
      const toolResult = await callLlmWithTools(
        messages,
        model,
        provider,
        useOwnKey,
        maxTokens
      );
      if (toolResult?.content) {
        if (stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-1Claw-Chat-Bridge": FRAMEWORK,
            "X-1Claw-Chat-Mode": "bridge-tools",
          });
          const chunk = {
            id: `chatcmpl-bridge-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: toolResult.content }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          const done = {
            ...chunk,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          };
          res.write(`data: ${JSON.stringify(done)}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        return sendJson(res, 200, {
          id: `chatcmpl-bridge-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message: { role: "assistant", content: toolResult.content },
            finish_reason: "stop",
          }],
          usage: { tool_rounds: toolResult.tool_rounds },
        });
      }
    } catch (e) {
      console.error("[chat-bridge] tool loop error:", e.message);
    }
  }

  const upstream = resolveUpstream(provider, useOwnKey);

  const payload = JSON.stringify({
    model,
    messages,
    stream,
    temperature: body.temperature,
    max_tokens: resolveMaxTokens(body),
  });

  let upstreamResp;
  try {
    upstreamResp = await proxyRequest(
      upstream.url,
      buildAuthHeaders(provider),
      Buffer.from(payload),
      { stream }
    );
  } catch (e) {
    console.error("[chat-bridge] upstream connect failed:", e.message, "via", upstream.via);
    return sendJson(res, 502, {
      error: {
        message: `LLM connection failed: ${e.message}. Enable Shroud on your agent (Dashboard → Agents → Shroud LLM Proxy), or add provider keys under Dashboard → Runtimes → Config → API Keys.`,
      },
    });
  }

  if (stream) {
    res.writeHead(upstreamResp.statusCode || 502, {
      "Content-Type":
        upstreamResp.headers["content-type"] || "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-1Claw-Chat-Bridge": FRAMEWORK,
      "X-1Claw-Chat-Via": upstream.via,
    });
    upstreamResp.pipe(res);
    upstreamResp.on("error", (e) => {
      console.error("[chat-bridge] stream error:", e.message);
      res.end();
    });
    return;
  }

  const chunks = [];
  for await (const c of upstreamResp) chunks.push(c);
  const respBuf = Buffer.concat(chunks);
  res.writeHead(upstreamResp.statusCode || 502, {
    "Content-Type":
      upstreamResp.headers["content-type"] || "application/json",
    "X-1Claw-Chat-Bridge": FRAMEWORK,
    "X-1Claw-Chat-Via": upstream.via,
  });
  res.end(respBuf);
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  const method = req.method || "GET";

  if (method === "GET" && (url === "/health" || url === "/healthz")) {
    return sendJson(res, 200, {
      status: "ok",
      framework: FRAMEWORK,
      chat: true,
      mode: "bridge",
      agent_id: AGENT_ID || null,
      runtime_id: RUNTIME_ID || null,
    });
  }

  if (method === "POST" && url === "/v1/chat/completions") {
    try {
      return await handleChatCompletions(req, res);
    } catch (e) {
      console.error("[chat-bridge] handler error:", e);
      if (!res.headersSent) {
        return sendJson(res, 500, { error: { message: "internal error" } });
      }
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
  console.error("[chat-bridge] listen error:", err.message);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  const upstream = resolveUpstream(DEFAULT_PROVIDER, false);
  console.log(
    `1claw chat-bridge (${FRAMEWORK}) on 127.0.0.1:${PORT} → ${upstream.url} (${upstream.via})`
  );
});
