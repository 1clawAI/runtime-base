"use strict";

/**
 * Multi-chain signing key discovery for runtime agents.
 * Private keys live in the __agent-keys system vault and are NOT listable via list_secrets.
 * Use these tools to get public addresses and balances.
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { apiAuthHeaders } = require("../agent-token.js");
const { formatApiError } = require("./api-error.js");

async function httpRequest(url, method, headers, body) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  const bodyBuf = body != null ? Buffer.from(JSON.stringify(body)) : null;
  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === "https:" ? 443 : 80),
    path: u.pathname + u.search,
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    timeout: 30000,
  };
  if (bodyBuf) opts.headers["Content-Length"] = bodyBuf.length;

  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (resp) => {
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () =>
        resolve({ status: resp.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") })
      );
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
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
      name: "list_signing_keys",
      description:
        "List this agent's provisioned multi-chain signing keys (Ethereum, XRP, Bitcoin, Solana, etc.). " +
        "Returns chain, address, and public_key — never private keys. " +
        "Signing keys are NOT stored in the user vault secret list; do not search agent_keys/ or __agent-keys paths.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_signing_key_balance",
      description:
        "Get native and optional token balances for a provisioned signing key address on a chain " +
        "(e.g. ethereum, xrp). Use list_signing_keys first to discover available chains and addresses.",
      parameters: {
        type: "object",
        properties: {
          chain: {
            type: "string",
            description: "Chain name (ethereum, xrp, bitcoin, solana, cardano, tron, or network alias like sepolia)",
          },
          tokens: {
            type: "string",
            description:
              "Optional comma-separated token contract addresses or mints to include (ERC-20/SPL/TRC-20)",
          },
        },
        required: ["chain"],
      },
    },
  },
];

async function execute(toolName, args, context) {
  const { agentToken, agentId, baseUrl } = context;
  const headers = authHeaders(agentToken);

  if (!agentId) {
    return { error: "ONECLAW_AGENT_ID is not configured for this runtime" };
  }

  switch (toolName) {
    case "list_signing_keys": {
      const url = `${baseUrl}/v1/agents/${agentId}/signing-keys`;
      const resp = await httpRequest(url, "GET", headers, null);
      if (resp.status >= 400) {
        return formatApiError(resp.status, resp.text, "list_signing_keys");
      }
      const data = JSON.parse(resp.text);
      const keys = (data.keys || []).map((k) => ({
        chain: k.chain,
        address: k.address,
        public_key: k.public_key,
        curve: k.curve,
        key_version: k.key_version,
      }));
      return {
        keys,
        count: keys.length,
        note:
          keys.length === 0
            ? "No signing keys provisioned yet. Ask your operator to add chains in the agent dashboard (Signing keys)."
            : "Private keys are server-side only. Use Intents API (submit_transaction/sign) or get_signing_key_balance for on-chain actions.",
      };
    }

    case "get_signing_key_balance": {
      const { chain, tokens } = args;
      if (!chain) return { error: "chain is required" };
      let url = `${baseUrl}/v1/agents/${agentId}/signing-keys/${encodeURIComponent(chain)}/balance`;
      if (tokens && String(tokens).trim()) {
        url += `?tokens=${encodeURIComponent(String(tokens).trim())}`;
      }
      const resp = await httpRequest(url, "GET", headers, null);
      if (resp.status >= 400) {
        return formatApiError(resp.status, resp.text, "get_signing_key_balance");
      }
      return JSON.parse(resp.text);
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

function isAvailable(env) {
  return Boolean(
    (env.ONECLAW_AGENT_TOKEN || env.ONECLAW_TOKEN || env.ONECLAW_AGENT_API_KEY) &&
      env.ONECLAW_AGENT_ID
  );
}

module.exports = { definitions, execute, isAvailable };
