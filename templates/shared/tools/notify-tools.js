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

let _channelCache = null;
let _channelCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchChannels(baseUrl, agentId, token) {
  const now = Date.now();
  if (_channelCache && (now - _channelCacheTime) < CACHE_TTL_MS) {
    return _channelCache;
  }
  const url = `${baseUrl}/v1/agents/${agentId}/channels`;
  const resp = await httpRequest(url, "GET", authHeaders(token), null);
  if (resp.status >= 400) return [];
  const data = JSON.parse(resp.text);
  _channelCache = data.channels || data || [];
  _channelCacheTime = now;
  return _channelCache;
}

async function findChannel(baseUrl, agentId, token, type, channelId) {
  const channels = await fetchChannels(baseUrl, agentId, token);
  if (channelId) {
    return channels.find((c) => c.id === channelId && c.channel_type === type) || null;
  }
  return channels.find((c) => c.channel_type === type && c.is_active) || null;
}

const definitions = [
  {
    type: "function",
    function: {
      name: "send_email",
      description: "Send an email via a configured SMTP execution binding.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address" },
          subject: { type: "string", description: "Email subject line" },
          body: { type: "string", description: "Email body (plain text or HTML)" },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_telegram",
      description: "Send a message to a connected Telegram channel.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Message text to send" },
          channel_id: { type: "string", description: "Specific channel ID (uses first active Telegram channel if omitted)" },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_discord",
      description: "Send a message to a connected Discord channel.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Message text to send" },
          channel_id: { type: "string", description: "Specific channel ID (uses first active Discord channel if omitted)" },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_reminder",
      description: "Schedule a one-time reminder notification to be delivered later.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Reminder message content" },
          delay_minutes: { type: "number", description: "Minutes from now to deliver the reminder" },
          channel: { type: "string", description: "Delivery channel", enum: ["telegram", "discord", "email"], default: "telegram" },
        },
        required: ["message", "delay_minutes"],
      },
    },
  },
];

async function execute(toolName, args, context) {
  const { agentToken, agentId, baseUrl } = context;
  const headers = authHeaders(agentToken);

  switch (toolName) {
    case "send_email": {
      const { to, subject, body } = args;
      if (!to || !subject || !body) return { error: "to, subject, and body are required" };

      const bindingsUrl = `${baseUrl}/v1/agents/${agentId}/bindings`;
      const bindingsResp = await httpRequest(bindingsUrl, "GET", headers, null);
      if (bindingsResp.status >= 400) {
        return { error: "Failed to fetch bindings. Ensure execution intents are enabled." };
      }
      const bindingsData = JSON.parse(bindingsResp.text);
      const bindings = bindingsData.bindings || bindingsData || [];
      const smtpBinding = bindings.find((b) => b.binding_type === "smtp" && b.is_active);

      if (!smtpBinding) {
        return {
          error: "No active SMTP binding configured.",
          hint:
            "Ask your operator to create an SMTP binding in the dashboard, or use request_approval with action binding_request.",
        };
      }

      const execUrl = `${baseUrl}/v1/agents/${agentId}/execute`;
      const execBody = {
        binding: smtpBinding.id,
        intent_type: "smtp",
        params: { to, subject, body },
      };
      const execResp = await httpRequest(execUrl, "POST", headers, execBody);
      if (execResp.status >= 400) {
        return formatApiError(execResp.status, execResp.text, "send_email");
      }
      return { success: true, to, subject };
    }

    case "send_telegram": {
      const { message, channel_id } = args;
      if (!message) return { error: "message is required" };

      const channel = await findChannel(baseUrl, agentId, agentToken, "telegram", channel_id);
      if (!channel) {
        return {
          error: "No active Telegram channel found.",
          hint:
            "Channel setup is human-only in the dashboard. Use list_channels to see connected channels, or ask your operator to connect Telegram.",
        };
      }

      const sendUrl = `${baseUrl}/v1/agents/${agentId}/channels/${channel.id}/send`;
      const resp = await httpRequest(sendUrl, "POST", headers, { content: message });
      if (resp.status >= 400) {
        return formatApiError(resp.status, resp.text, "send_telegram");
      }
      return { success: true, channel_id: channel.id, channel_name: channel.channel_name };
    }

    case "send_discord": {
      const { message, channel_id } = args;
      if (!message) return { error: "message is required" };

      const channel = await findChannel(baseUrl, agentId, agentToken, "discord", channel_id);
      if (!channel) {
        return {
          error: "No active Discord channel found.",
          hint:
            "Channel setup is human-only in the dashboard. Use list_channels to see connected channels, or ask your operator to connect Discord.",
        };
      }

      const sendUrl = `${baseUrl}/v1/agents/${agentId}/channels/${channel.id}/send`;
      const resp = await httpRequest(sendUrl, "POST", headers, { content: message });
      if (resp.status >= 400) {
        return formatApiError(resp.status, resp.text, "send_discord");
      }
      return { success: true, channel_id: channel.id, channel_name: channel.channel_name };
    }

    case "schedule_reminder": {
      const { message, delay_minutes, channel } = args;
      if (!message || !delay_minutes) return { error: "message and delay_minutes are required" };

      const deliveryChannel = channel || "telegram";
      const waitSecs = Math.min(Math.max(Math.round(delay_minutes * 60), 1), 1800);

      const steps = [
        { type: "wait", name: "delay", params: { duration_secs: waitSecs } },
      ];

      if (deliveryChannel === "email") {
        steps.push({
          type: "notify",
          name: "deliver",
          params: {
            channel: "email",
            to: args.to || process.env.ONECLAW_REMINDER_EMAIL,
            subject: args.subject || "Reminder",
            body: message,
          },
        });
        if (!steps[1].params.to) {
          return { error: "email reminders require params.to or ONECLAW_REMINDER_EMAIL" };
        }
      } else {
        const platformChannel = await findChannel(
          baseUrl,
          agentId,
          agentToken,
          deliveryChannel === "discord" ? "discord" : "telegram",
          args.channel_id
        );
        if (!platformChannel) {
          return {
            error: `No active ${deliveryChannel} channel found. Connect one via the dashboard or pass channel_id.`,
          };
        }
        steps.push({
          type: "notify",
          name: "deliver",
          params: {
            channel: "channel",
            channel_id: platformChannel.id,
            message,
            text: message,
          },
        });
      }

      const automationBody = {
        name: `Reminder: ${message.substring(0, 40)}`,
        trigger_type: "manual",
        workflow_spec: { steps },
        auto_trigger: true,
      };

      const createUrl = `${baseUrl}/v1/agents/${agentId}/automations`;
      const createResp = await httpRequest(createUrl, "POST", headers, automationBody);
      if (createResp.status >= 400) {
        return formatApiError(createResp.status, createResp.text, "schedule_reminder");
      }
      const automation = JSON.parse(createResp.text);
      const automationId = automation.id || automation.automation?.id;

      return {
        success: true,
        automation_id: automationId,
        message: "Reminder scheduled",
        delay_minutes,
        channel: deliveryChannel,
        note: "Wait steps cap at 30 seconds per run; longer delays require human-created cron automations.",
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
