#!/usr/bin/env node
/**
 * Web Search Tool
 *
 * Supports Brave Search, Tavily, SerpAPI (auto-detect from env), an
 * execution intent binding named "web-search", or — when none of those are
 * configured — a platform-default fallback proxied through the vault
 * (POST /v1/tools/web-search), so every agent gets working search out of
 * the box. The fallback's own API key never reaches this container; vault
 * calls Brave server-side and enforces a shared monthly cap across all
 * orgs (see vault's domain/platform_web_search.rs).
 */
"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");

const definition = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web for current information. Returns titles, URLs, and snippets.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
        num_results: {
          type: "number",
          description: "Number of results to return (default 5, max 20)",
        },
      },
      required: ["query"],
    },
  },
};

function isAvailable() {
  // Always available: an agent with none of its own providers configured
  // falls back to the platform-default proxy (see execute() below).
  return true;
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
      Accept: "application/json",
      ...headers,
    },
    timeout: timeoutMs,
  };
  if (payload) {
    opts.headers["Content-Type"] = "application/json";
    opts.headers["Content-Length"] = Buffer.byteLength(payload);
  }

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
      reject(new Error("Search request timed out"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function searchBrave(query, numResults, apiKey) {
  const count = Math.min(numResults, 20);
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const resp = await httpRequest(url, "GET", {
    "X-Subscription-Token": apiKey,
  });
  if (resp.status !== 200) {
    return { error: `Brave Search returned ${resp.status}: ${resp.text.slice(0, 200)}` };
  }
  const data = JSON.parse(resp.text);
  const results = (data.web?.results || []).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.description || "",
  }));
  return { results, provider: "brave" };
}

async function searchTavily(query, numResults, apiKey) {
  const resp = await httpRequest(
    "https://api.tavily.com/search",
    "POST",
    {},
    {
      api_key: apiKey,
      query,
      max_results: Math.min(numResults, 20),
      search_depth: "basic",
    }
  );
  if (resp.status !== 200) {
    return { error: `Tavily returned ${resp.status}: ${resp.text.slice(0, 200)}` };
  }
  const data = JSON.parse(resp.text);
  const results = (data.results || []).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.content || "",
  }));
  return { results, provider: "tavily" };
}

async function searchSerp(query, numResults, apiKey) {
  const num = Math.min(numResults, 20);
  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&num=${num}&api_key=${apiKey}`;
  const resp = await httpRequest(url, "GET", {});
  if (resp.status !== 200) {
    return { error: `SerpAPI returned ${resp.status}: ${resp.text.slice(0, 200)}` };
  }
  const data = JSON.parse(resp.text);
  const results = (data.organic_results || []).map((r) => ({
    title: r.title || "",
    url: r.link || "",
    snippet: r.snippet || "",
  }));
  return { results, provider: "serpapi" };
}

// Vault call headers for a runtime-injected agent JWT. Runtime tokens carry a
// `runtime_id` claim and Vault's auth middleware rejects them (401
// "Runtime-bound token requires matching X-1Claw-Runtime-Id header") unless the
// X-1Claw-Runtime-Id header is present — the same header agent-token.js's
// apiAuthHeaders() sends for the built-in tools. Omitting it is what surfaced to
// chat as "unable to perform web searches ... due to authorization restrictions".
function vaultAuthHeaders(context) {
  const env = context.env || process.env;
  const headers = { Authorization: `Bearer ${context.agentToken}` };
  const runtimeId = env.ONECLAW_RUNTIME_ID;
  if (runtimeId) headers["X-1Claw-Runtime-Id"] = runtimeId;
  return headers;
}

async function searchViaBinding(query, numResults, context) {
  const baseUrl = context.baseUrl;
  const agentId = context.agentId;
  if (!baseUrl || !agentId || !context.agentToken) {
    return { error: "Missing context for execution intent binding" };
  }

  const url = `${baseUrl}/v1/agents/${agentId}/execute`;
  const resp = await httpRequest(
    url,
    "POST",
    vaultAuthHeaders(context),
    {
      binding: "web-search",
      intent_type: "http",
      params: {
        query,
        num_results: numResults,
      },
    }
  );
  if (resp.status !== 200) {
    return { error: `Execution intent binding failed: ${resp.text.slice(0, 200)}` };
  }
  const data = JSON.parse(resp.text);
  const results = Array.isArray(data.results)
    ? data.results
    : Array.isArray(data.body?.results)
      ? data.body.results
      : [];
  return {
    results: results.map((r) => ({
      title: r.title || "",
      url: r.url || r.link || "",
      snippet: r.snippet || r.content || r.description || "",
    })),
    provider: "binding",
  };
}

function resolveVaultBase(context) {
  const env = context.env || process.env;
  const raw =
    env.ONECLAW_VAULT_INTERNAL_URL ||
    context.baseUrl ||
    env.ONECLAW_BASE_URL ||
    env.ONECLAW_API_URL ||
    "";
  return String(raw).replace(/\/$/, "");
}

async function searchViaPlatformDefault(query, numResults, context) {
  const baseUrl = resolveVaultBase(context);
  if (!baseUrl || !context.agentToken) {
    return {
      error:
        "Missing context for the platform default search fallback (need an agent JWT and ONECLAW_BASE_URL / ONECLAW_VAULT_INTERNAL_URL). Stop then Start the runtime.",
    };
  }
  const resp = await httpRequest(
    `${baseUrl}/v1/tools/web-search`,
    "POST",
    vaultAuthHeaders(context),
    { query, num_results: numResults }
  );
  if (resp.status !== 200) {
    let message = resp.text.slice(0, 300);
    try {
      const parsed = JSON.parse(resp.text);
      message = parsed?.error?.message || parsed?.detail || message;
    } catch { /* keep raw text */ }
    if (resp.status === 401 || resp.status === 403) {
      return {
        error:
          `Web search was refused (${resp.status}): ${message}. ` +
          "The fallback requires the agent's own JWT. Stop then Start the runtime so Vault injects a fresh token.",
      };
    }
    return { error: message };
  }
  const data = JSON.parse(resp.text);
  return {
    results: Array.isArray(data.results) ? data.results : [],
    provider: data.provider || "platform-default",
  };
}

async function execute(_name, args, context) {
  const query = (args.query || "").trim();
  if (!query) return { error: "query is required" };

  const numResults = Math.max(1, Math.min(args.num_results || 5, 20));
  const env = context.env || process.env;

  try {
    if (env.BRAVE_API_KEY) {
      return await searchBrave(query, numResults, env.BRAVE_API_KEY);
    }
    if (env.TAVILY_API_KEY) {
      return await searchTavily(query, numResults, env.TAVILY_API_KEY);
    }
    if (env.SERP_API_KEY) {
      return await searchSerp(query, numResults, env.SERP_API_KEY);
    }
    if (env.ONECLAW_WEB_SEARCH_BINDING) {
      return await searchViaBinding(query, numResults, context);
    }
    return await searchViaPlatformDefault(query, numResults, context);
  } catch (e) {
    return { error: `Web search failed: ${e.message}` };
  }
}

module.exports = {
  definition,
  definitions: [definition],
  isAvailable,
  execute,
};
