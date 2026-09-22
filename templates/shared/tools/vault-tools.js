"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { apiAuthHeaders } = require("../agent-token.js");
const { formatApiError } = require("./api-error.js");

async function httpRequest(url, method, headers, body) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null;
  const opts = {
    protocol: u.protocol, hostname: u.hostname,
    port: u.port || (u.protocol === "https:" ? 443 : 80),
    path: u.pathname + u.search, method,
    headers: { "Content-Type": "application/json", ...headers },
    timeout: 30000,
  };
  if (bodyBuf) opts.headers["Content-Length"] = bodyBuf.length;
  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (resp) => {
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () => resolve({ status: resp.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function authHeaders(token) {
  return apiAuthHeaders(token);
}

const definitions = [
  {
    type: "function",
    function: {
      name: "store_secret",
      description: "Store a secret value in the agent's vault at the given path. Creates a new version if the path already exists.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Secret path (e.g. 'api-keys/openai')" },
          value: { type: "string", description: "The secret value to store" },
          type: { type: "string", description: "Secret type hint", enum: ["api_key", "password", "generic", "credential", "certificate"] },
        },
        required: ["path", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "retrieve_secret",
      description: "Retrieve a secret value from the agent's vault by path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Secret path to retrieve" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_secrets",
      description: "List secret paths in the agent's vault, optionally filtered by prefix.",
      parameters: {
        type: "object",
        properties: {
          prefix: { type: "string", description: "Optional prefix filter (e.g. 'api-keys/')" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rotate_secret",
      description: "Rotate a secret server-side, generating a new cryptographically random value.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Secret path to rotate" },
          length: { type: "number", description: "Length of generated value (8-1024, default 32)" },
          charset: { type: "string", description: "Character set for the generated value", enum: ["hex", "base64", "alphanumeric", "ascii"] },
        },
        required: ["path"],
      },
    },
  },
];

async function execute(toolName, args, context) {
  const { agentToken, vaultId, baseUrl } = context;
  const headers = authHeaders(agentToken);

  switch (toolName) {
    case "store_secret": {
      const { path, value, type } = args;
      if (!path || !value) return { error: "path and value are required" };
      const url = `${baseUrl}/v1/vaults/${vaultId}/secrets/${encodeURIComponent(path)}`;
      const body = { value };
      if (type) body.secret_type = type;
      const resp = await httpRequest(url, "PUT", headers, body);
      if (resp.status >= 400) {
        return formatApiError(resp.status, resp.text, "store_secret");
      }
      const data = JSON.parse(resp.text);
      return { success: true, path, version: data.version || 1 };
    }

    case "retrieve_secret": {
      const { path } = args;
      if (!path) return { error: "path is required" };
      const url = `${baseUrl}/v1/vaults/${vaultId}/secrets/${encodeURIComponent(path)}`;
      const resp = await httpRequest(url, "GET", headers, null);
      if (resp.status === 404) return { error: "Secret not found", path };
      if (resp.status >= 400) {
        return formatApiError(resp.status, resp.text, "retrieve_secret");
      }
      const data = JSON.parse(resp.text);
      return { value: data.value, type: data.secret_type, version: data.version, created_at: data.created_at };
    }

    case "list_secrets": {
      const { prefix } = args;
      let url = `${baseUrl}/v1/vaults/${vaultId}/secrets`;
      if (prefix) url += `?prefix=${encodeURIComponent(prefix)}`;
      const resp = await httpRequest(url, "GET", headers, null);
      if (resp.status >= 400) {
        return formatApiError(resp.status, resp.text, "list_secrets");
      }
      return JSON.parse(resp.text);
    }

    case "rotate_secret": {
      const { path, length, charset } = args;
      if (!path) return { error: "path is required" };
      const url = `${baseUrl}/v1/vaults/${vaultId}/secret-rotate/${encodeURIComponent(path)}`;
      const body = {};
      if (length) body.length = length;
      if (charset) body.charset = charset;
      const resp = await httpRequest(url, "POST", headers, body);
      if (resp.status >= 400) {
        return formatApiError(resp.status, resp.text, "rotate_secret");
      }
      const data = JSON.parse(resp.text);
      return { success: true, path, version: data.version };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

function isAvailable(env) {
  return Boolean(env.ONECLAW_VAULT_ID);
}

module.exports = { definitions, execute, isAvailable };
