"use strict";

/**
 * Agent self-service tools: approvals, channel/binding discovery.
 * Complements human-only dashboard configuration with chat-native workflows.
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
      name: "request_approval",
      description:
        "Ask your human operator to approve a sensitive change (policy access, new binding, delegation, channel setup, etc.). " +
        "Use when you cannot complete a task yourself (e.g. binding creation, cron schedules, swap/http steps). " +
        "Returns an approval ID to poll with check_approval_status.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "Action type, e.g. policy_change, binding_request, access_request",
          },
          target_type: {
            type: "string",
            description: "Resource type, e.g. policy, vault, binding, secret",
          },
          target_id: {
            type: "string",
            description: "UUID or identifier of the target resource",
          },
          summary: {
            type: "object",
            description:
              "JSON payload describing the requested change (for policy_change: vault_id, paths, permissions)",
          },
          reason: { type: "string", description: "Human-readable explanation" },
          risk_tier: {
            type: "number",
            description: "Risk 1 (low) to 5 (critical). Default 1",
          },
        },
        required: ["action", "target_type", "target_id", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_approval_status",
      description: "Poll status of an approval you requested (pending, approved, rejected, expired).",
      parameters: {
        type: "object",
        properties: {
          approval_id: { type: "string", description: "Approval UUID from request_approval" },
        },
        required: ["approval_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_channels",
      description:
        "List messaging channels (Telegram, Discord, WhatsApp) connected to this agent. " +
        "Use channel IDs in notify automations and send_telegram/send_discord. " +
        "Channel OAuth setup is human-only — use request_approval if none exist.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_bindings",
      description:
        "List execution intent bindings configured for this agent (HTTP, SMTP, etc.). " +
        "Use binding names with execute_intent. Binding creation is human-only — use request_approval to ask your operator.",
      parameters: { type: "object", properties: {} },
    },
  },
];

async function execute(toolName, args, context) {
  const { agentToken, agentId, baseUrl } = context;
  if (!agentId || !agentToken) {
    return { error: "Agent credentials not available for this tool" };
  }
  const headers = authHeaders(agentToken);

  switch (toolName) {
    case "request_approval": {
      const { action, target_type, target_id, summary, reason, risk_tier } = args;
      if (!action || !target_type || !target_id || !summary) {
        return { error: "action, target_type, target_id, and summary are required" };
      }
      const url = `${baseUrl}/v1/approvals/request`;
      const body = { action, target_type, target_id, summary, reason, risk_tier };
      const resp = await httpRequest(url, "POST", headers, body);
      if (resp.status !== 202 && resp.status !== 200 && resp.status !== 201) {
        return formatApiError(resp.status, resp.text, "request_approval");
      }
      const data = JSON.parse(resp.text);
      return {
        success: true,
        approval_id: data.id,
        status: data.status,
        expires_at: data.expires_at,
        message:
          "Approval sent to your human operator. Poll check_approval_status or wait for them to approve in the dashboard.",
      };
    }

    case "check_approval_status": {
      const approvalId = (args.approval_id || "").trim();
      if (!approvalId) return { error: "approval_id is required" };
      const url = `${baseUrl}/v1/approvals/${approvalId}/status`;
      const resp = await httpRequest(url, "GET", headers, null);
      if (resp.status >= 400) {
        return formatApiError(resp.status, resp.text, "check_approval_status");
      }
      return JSON.parse(resp.text);
    }

    case "list_channels": {
      const url = `${baseUrl}/v1/agents/${agentId}/channels`;
      const resp = await httpRequest(url, "GET", headers, null);
      if (resp.status >= 400) {
        return formatApiError(resp.status, resp.text, "list_channels");
      }
      const data = JSON.parse(resp.text);
      const channels = (data.channels || []).map((c) => ({
        id: c.id,
        channel_type: c.channel_type,
        channel_name: c.channel_name,
        is_active: c.is_active,
        auto_respond_enabled: c.auto_respond_enabled,
        is_home_platform: c.is_home_platform,
      }));
      return {
        channels,
        count: channels.length,
        note:
          channels.length === 0
            ? "No channels connected. Ask your operator to connect Telegram/Discord in the agent dashboard."
            : undefined,
      };
    }

    case "list_bindings": {
      const url = `${baseUrl}/v1/agents/${agentId}/bindings`;
      const resp = await httpRequest(url, "GET", headers, null);
      if (resp.status >= 400) {
        return formatApiError(resp.status, resp.text, "list_bindings");
      }
      const data = JSON.parse(resp.text);
      const bindings = (data.bindings || data || []).map((b) => ({
        id: b.id,
        name: b.name,
        binding_type: b.binding_type,
        is_active: b.is_active,
        credential_set: b.credential_set,
        credential_source_type: b.credential_source_type,
      }));
      return {
        bindings,
        count: bindings.length,
        note:
          bindings.length === 0
            ? "No bindings configured. Use request_approval to ask your operator to create execution bindings."
            : "Use execute_intent or channel-specific tools with these binding names.",
      };
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
