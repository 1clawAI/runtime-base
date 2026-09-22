"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");

// ---------------------------------------------------------------------------
// HTTP helpers (Node built-in only)
// ---------------------------------------------------------------------------

function httpRequest(url, method, headers, body) {
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
      ...(payload
        ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          }
        : {}),
    },
    timeout: 30000,
  };

  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (resp) => {
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: resp.statusCode || 0, text });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("request timeout"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Connection cache (5-minute TTL, per provider)
// ---------------------------------------------------------------------------

const _connectionCache = {};
const _connectionCacheExpiry = {};

async function getOAuthConnections(context) {
  const url = `${context.baseUrl}/v1/agents/${context.agentId}/oauth/connections`;
  try {
    const resp = await httpRequest(url, "GET", {
      Authorization: `Bearer ${context.agentToken}`,
    });
    if (resp.status >= 400) return [];
    const data = JSON.parse(resp.text);
    return data.connections || data || [];
  } catch {
    return [];
  }
}

async function getProviderConnection(context, provider) {
  const now = Date.now();
  if (_connectionCache[provider] && now < (_connectionCacheExpiry[provider] || 0)) {
    return _connectionCache[provider];
  }

  const connections = await getOAuthConnections(context);
  if (!Array.isArray(connections)) return null;

  const match = connections.find(
    (c) =>
      c.provider === provider ||
      c.provider_slug === provider ||
      c.oauth2_provider === provider,
  );

  if (match) {
    _connectionCache[provider] = match;
    _connectionCacheExpiry[provider] = now + 5 * 60 * 1000;
  }
  return match || null;
}

function getBindingId(connection) {
  return connection.binding_id || connection.id || null;
}

// ---------------------------------------------------------------------------
// Execute via 1Claw execution intent
// ---------------------------------------------------------------------------

async function executeViaBinding(context, bindingId, params) {
  const url = `${context.baseUrl}/v1/agents/${context.agentId}/execute`;
  const resp = await httpRequest(
    url,
    "POST",
    { Authorization: `Bearer ${context.agentToken}` },
    { binding: bindingId, intent_type: "http", params },
  );
  const data = JSON.parse(resp.text);
  if (resp.status >= 400) {
    const detail = data.detail || data.message || data.error || resp.text.slice(0, 300);
    return { error: `Execution failed (${resp.status}): ${detail}` };
  }
  return data;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const definitions = [
  {
    type: "function",
    function: {
      name: "post_to_x",
      description:
        "Post a tweet to X (formerly Twitter). Text is limited to 280 characters.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "Tweet text (max 280 characters)",
            maxLength: 280,
          },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "post_to_linkedin",
      description:
        "Post a text update to the LinkedIn feed of the connected user.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "Post text content",
          },
        },
        required: ["text"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executePostToX(args, context) {
  const conn = await getProviderConnection(context, "x");
  if (!conn) {
    const twitterConn = await getProviderConnection(context, "twitter");
    if (!twitterConn) return { error: "No X (Twitter) OAuth connection found for this agent" };
    return await doPostToX(args, context, twitterConn);
  }
  return await doPostToX(args, context, conn);
}

async function doPostToX(args, context, conn) {
  const bindingId = getBindingId(conn);
  if (!bindingId) return { error: "X connection has no binding ID" };

  if (!args.text) return { error: "text is required" };
  if (args.text.length > 280) {
    return { error: `Tweet exceeds 280 character limit (${args.text.length} chars)` };
  }

  const result = await executeViaBinding(context, bindingId, {
    url: "https://api.x.com/2/tweets",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: args.text }),
  });

  if (result.error) return result;

  try {
    const body =
      typeof result.body === "string" ? JSON.parse(result.body) : result.body || result;
    if (body.errors) {
      return { error: `X API error: ${body.errors.map((e) => e.message).join(", ")}` };
    }
    return {
      id: body.data?.id,
      text: body.data?.text,
    };
  } catch {
    return result;
  }
}

async function executePostToLinkedIn(args, context) {
  const conn = await getProviderConnection(context, "linkedin");
  if (!conn) return { error: "No LinkedIn OAuth connection found for this agent" };

  const bindingId = getBindingId(conn);
  if (!bindingId) return { error: "LinkedIn connection has no binding ID" };

  if (!args.text) return { error: "text is required" };

  // LinkedIn v2 UGC Post API — the execution binding's OAuth token carries the
  // user identity, so `author` is resolved by the binding credential.
  const postBody = {
    author: "urn:li:person:me",
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text: args.text },
        shareMediaCategory: "NONE",
      },
    },
    visibility: {
      "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
    },
  };

  const result = await executeViaBinding(context, bindingId, {
    url: "https://api.linkedin.com/v2/ugcPosts",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify(postBody),
  });

  if (result.error) return result;

  try {
    const body =
      typeof result.body === "string" ? JSON.parse(result.body) : result.body || result;
    return {
      id: body.id,
      status: "published",
    };
  } catch {
    return result;
  }
}

async function execute(toolName, args, context) {
  try {
    switch (toolName) {
      case "post_to_x":
        return await executePostToX(args, context);
      case "post_to_linkedin":
        return await executePostToLinkedIn(args, context);
      default:
        return { error: `Unknown social tool: ${toolName}` };
    }
  } catch (e) {
    return { error: `Social tool error: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Availability check — true when X or LinkedIn is connected
// ---------------------------------------------------------------------------

function isAvailable(env) {
  return Boolean(
    (env.ONECLAW_AGENT_TOKEN || env.ONECLAW_TOKEN || env.ONECLAW_AGENT_API_KEY) &&
    env.ONECLAW_AGENT_ID
  );
}

module.exports = { definitions, execute, isAvailable };
