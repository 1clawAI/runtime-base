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
// Connection cache (5-minute TTL)
// ---------------------------------------------------------------------------

let _connectionCache = null;
let _connectionCacheExpiry = 0;

async function getSlackConnection(context) {
  const now = Date.now();
  if (_connectionCache && now < _connectionCacheExpiry) {
    return _connectionCache;
  }

  const url = `${context.baseUrl}/v1/agents/${context.agentId}/oauth/connections`;
  try {
    const resp = await httpRequest(url, "GET", {
      Authorization: `Bearer ${context.agentToken}`,
    });
    if (resp.status >= 400) return null;

    const data = JSON.parse(resp.text);
    const connections = data.connections || data || [];
    const slack = Array.isArray(connections)
      ? connections.find(
          (c) =>
            c.provider === "slack" ||
            c.provider_slug === "slack" ||
            c.oauth2_provider === "slack",
        )
      : null;

    if (slack) {
      _connectionCache = slack;
      _connectionCacheExpiry = now + 5 * 60 * 1000;
    }
    return slack || null;
  } catch {
    return null;
  }
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
      name: "slack_send_message",
      description:
        "Send a message to a Slack channel. The channel can be a name (e.g. 'general') or a channel ID.",
      parameters: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: "Slack channel name or ID (e.g. 'general' or 'C01ABCDEF')",
          },
          text: { type: "string", description: "Message text (supports Slack markdown)" },
        },
        required: ["channel", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "slack_list_channels",
      description:
        "List available Slack channels the bot has access to. Returns channel names and IDs.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of channels to return (default 50)",
          },
        },
        required: [],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeSendMessage(args, context) {
  const conn = await getSlackConnection(context);
  if (!conn) return { error: "No Slack OAuth connection found for this agent" };

  const bindingId = getBindingId(conn);
  if (!bindingId) return { error: "Slack connection has no binding ID" };

  if (!args.channel || !args.text) {
    return { error: "channel and text are required" };
  }

  const result = await executeViaBinding(context, bindingId, {
    url: "https://slack.com/api/chat.postMessage",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channel: args.channel,
      text: args.text,
    }),
  });

  if (result.error) return result;

  try {
    const body =
      typeof result.body === "string" ? JSON.parse(result.body) : result.body || result;
    if (body.ok === false) {
      return { error: `Slack API error: ${body.error || "unknown"}` };
    }
    return {
      ok: true,
      channel: body.channel,
      ts: body.ts,
      message: body.message?.text,
    };
  } catch {
    return result;
  }
}

async function executeListChannels(args, context) {
  const conn = await getSlackConnection(context);
  if (!conn) return { error: "No Slack OAuth connection found for this agent" };

  const bindingId = getBindingId(conn);
  if (!bindingId) return { error: "Slack connection has no binding ID" };

  const limit = Math.min(Math.max(args.limit || 50, 1), 200);
  const listUrl = `https://slack.com/api/conversations.list?limit=${limit}&exclude_archived=true`;

  const result = await executeViaBinding(context, bindingId, {
    url: listUrl,
    method: "GET",
  });

  if (result.error) return result;

  try {
    const body =
      typeof result.body === "string" ? JSON.parse(result.body) : result.body || result;
    if (body.ok === false) {
      return { error: `Slack API error: ${body.error || "unknown"}` };
    }
    const channels = (body.channels || []).map((c) => ({
      id: c.id,
      name: c.name,
      is_member: c.is_member,
      topic: c.topic?.value,
      num_members: c.num_members,
    }));
    return { channels, count: channels.length };
  } catch {
    return result;
  }
}

async function execute(toolName, args, context) {
  try {
    switch (toolName) {
      case "slack_send_message":
        return await executeSendMessage(args, context);
      case "slack_list_channels":
        return await executeListChannels(args, context);
      default:
        return { error: `Unknown Slack tool: ${toolName}` };
    }
  } catch (e) {
    return { error: `Slack tool error: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Availability check
// ---------------------------------------------------------------------------

function isAvailable(env) {
  return Boolean(
    (env.ONECLAW_AGENT_TOKEN || env.ONECLAW_TOKEN || env.ONECLAW_AGENT_API_KEY) &&
    env.ONECLAW_AGENT_ID
  );
}

module.exports = { definitions, execute, isAvailable };
