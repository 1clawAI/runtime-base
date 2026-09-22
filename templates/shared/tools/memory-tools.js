#!/usr/bin/env node
/**
 * Agent Memory Tools
 *
 * Three tools: remember (put), recall (get), search_memory (semantic search).
 * Uses 1Claw Memory API.
 */
"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { apiAuthHeaders } = require("../agent-token.js");

const DEFAULT_NAMESPACE = "agent-notes";

const rememberDef = {
  type: "function",
  function: {
    name: "remember",
    description:
      "Store a fact, preference, or piece of information in durable agent memory. " +
      "Persists across sessions. Use when the user asks you to remember something.",
    parameters: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "A short descriptive key (e.g. 'user_name', 'project_goal')",
        },
        value: {
          type: "string",
          description: "The information to remember",
        },
        tier: {
          type: "string",
          enum: ["scratch", "durable"],
          description:
            "Memory tier: scratch (ephemeral, auto-expires) or durable (persistent). Default: durable",
        },
        namespace: {
          type: "string",
          description: `Memory namespace (default: "${DEFAULT_NAMESPACE}")`,
        },
      },
      required: ["key", "value"],
    },
  },
};

const recallDef = {
  type: "function",
  function: {
    name: "recall",
    description:
      "Retrieve a specific memory entry by key. " +
      "Use when you need to look up a previously stored fact.",
    parameters: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "The memory key to look up",
        },
        namespace: {
          type: "string",
          description: `Memory namespace (default: "${DEFAULT_NAMESPACE}")`,
        },
      },
      required: ["key"],
    },
  },
};

const forgetDef = {
  type: "function",
  function: {
    name: "forget",
    description:
      "Delete a single memory entry by key. Use to remove outdated or incorrect facts you previously stored with remember.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "The memory key to delete" },
        namespace: {
          type: "string",
          description: `Memory namespace (default: "${DEFAULT_NAMESPACE}")`,
        },
      },
      required: ["key"],
    },
  },
};

const searchMemoryDef = {
  type: "function",
  function: {
    name: "search_memory",
    description:
      "Semantic search over agent memory. Use when you need to find related " +
      "memories but don't know the exact key.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query",
        },
        top_k: {
          type: "number",
          description: "Number of results to return (default 5, max 20)",
        },
        namespace: {
          type: "string",
          description: `Memory namespace (default: "${DEFAULT_NAMESPACE}")`,
        },
      },
      required: ["query"],
    },
  },
};

function isAvailable(env) {
  if (env.ONECLAW_MEMORY_ENABLED === "true" || env.ONECLAW_MEMORY_ENABLED === "1") {
    return true;
  }
  // NATIVE_AGENT_MEMORY defaults to "1" in native-agent-server.js;
  // only disable when explicitly set to "0".
  if (env.NATIVE_AGENT_MEMORY !== undefined) {
    return env.NATIVE_AGENT_MEMORY !== "0";
  }
  return false;
}

function httpRequest(url, method, headers, body, timeoutMs = 15000) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  const payload = body ? JSON.stringify(body) : null;
  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === "https:" ? 443 : 80),
    path: u.pathname + u.search,
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...headers,
    },
    timeout: timeoutMs,
  };
  if (payload) opts.headers["Content-Length"] = Buffer.byteLength(payload);

  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (resp) => {
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () => {
        resolve({
          status: resp.statusCode || 0,
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Memory API request timed out"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function authHeaders(context) {
  return apiAuthHeaders(context.agentToken);
}

async function executeRemember(args, context) {
  const key = (args.key || "").trim();
  const value = (args.value || "").trim();
  if (!key) return { error: "key is required" };
  if (!value) return { error: "value is required" };

  const namespace = args.namespace || DEFAULT_NAMESPACE;
  const tier = args.tier === "scratch" ? "scratch" : "durable";

  const url = `${context.baseUrl}/v1/agents/${context.agentId}/memory/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`;
  const resp = await httpRequest(url, "PUT", authHeaders(context), {
    value,
    tier,
  });

  if (resp.status !== 200 && resp.status !== 201) {
    return { error: `Failed to store memory: ${resp.text.slice(0, 200)}` };
  }
  return { success: true, namespace, key, tier };
}

async function executeRecall(args, context) {
  const key = (args.key || "").trim();
  if (!key) return { error: "key is required" };

  const namespace = args.namespace || DEFAULT_NAMESPACE;
  const url = `${context.baseUrl}/v1/agents/${context.agentId}/memory/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`;
  const resp = await httpRequest(url, "GET", authHeaders(context));

  if (resp.status === 404) {
    return { found: false, key, namespace };
  }
  if (resp.status !== 200) {
    return { error: `Failed to recall memory: ${resp.text.slice(0, 200)}` };
  }

  try {
    const data = JSON.parse(resp.text);
    return {
      found: true,
      key,
      namespace,
      value: data.value,
      tier: data.tier,
      updated_at: data.updated_at,
    };
  } catch {
    return { error: "Invalid response from memory API" };
  }
}

async function executeForget(args, context) {
  const key = (args.key || "").trim();
  if (!key) return { error: "key is required" };

  const namespace = args.namespace || DEFAULT_NAMESPACE;
  const url = `${context.baseUrl}/v1/agents/${context.agentId}/memory/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`;
  const resp = await httpRequest(url, "DELETE", authHeaders(context));

  if (resp.status === 404) {
    return { deleted: false, key, namespace, message: "No memory entry found for that key" };
  }
  if (resp.status !== 200) {
    return { error: `Failed to delete memory: ${resp.text.slice(0, 200)}` };
  }
  try {
    const data = JSON.parse(resp.text);
    return { deleted: data.deleted !== false, key, namespace };
  } catch {
    return { deleted: true, key, namespace };
  }
}

async function executeSearchMemory(args, context) {
  const query = (args.query || "").trim();
  if (!query) return { error: "query is required" };

  const namespace = args.namespace || DEFAULT_NAMESPACE;
  const topK = Math.max(1, Math.min(args.top_k || 5, 20));

  const url = `${context.baseUrl}/v1/agents/${context.agentId}/memory/search`;
  const resp = await httpRequest(url, "POST", authHeaders(context), {
    namespace,
    query,
    top_k: topK,
  });

  if (resp.status !== 200) {
    return { error: `Memory search failed: ${resp.text.slice(0, 200)}` };
  }

  try {
    return JSON.parse(resp.text);
  } catch {
    return { error: "Invalid response from memory search API" };
  }
}

async function execute(name, args, context) {
  if (!context.agentId) return { error: "Agent ID not available for memory operations" };
  if (!context.agentToken) return { error: "Agent token not available for memory operations" };

  switch (name) {
    case "remember":
      return executeRemember(args, context);
    case "recall":
      return executeRecall(args, context);
    case "search_memory":
      return executeSearchMemory(args, context);
    case "forget":
      return executeForget(args, context);
    default:
      return { error: `Unknown memory tool: ${name}` };
  }
}

module.exports = {
  definitions: [rememberDef, recallDef, searchMemoryDef, forgetDef],
  isAvailable,
  execute,
};
