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

async function getGoogleConnection(context) {
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
    const google = Array.isArray(connections)
      ? connections.find(
          (c) =>
            c.provider === "google" ||
            c.provider_slug === "google" ||
            c.oauth2_provider === "google",
        )
      : null;

    if (google) {
      _connectionCache = google;
      _connectionCacheExpiry = now + 5 * 60 * 1000;
    }
    return google || null;
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
      name: "google_calendar_list",
      description:
        "List upcoming Google Calendar events for the next 7 days from the user's primary calendar.",
      parameters: {
        type: "object",
        properties: {
          max_results: {
            type: "number",
            description: "Maximum number of events to return (default 10)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "google_calendar_create",
      description: "Create a new event on the user's primary Google Calendar.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Event title" },
          start: {
            type: "string",
            description: "Start time in ISO 8601 datetime format (e.g. 2026-08-12T10:00:00-05:00)",
          },
          end: {
            type: "string",
            description: "End time in ISO 8601 datetime format (e.g. 2026-08-12T11:00:00-05:00)",
          },
          description: {
            type: "string",
            description: "Optional event description",
          },
        },
        required: ["summary", "start", "end"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "google_search",
      description:
        "Search the web using Google Custom Search. Requires GOOGLE_CSE_ID and GOOGLE_API_KEY environment variables.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          num: {
            type: "number",
            description: "Number of results to return (1-10, default 5)",
          },
        },
        required: ["query"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeCalendarList(args, context) {
  const conn = await getGoogleConnection(context);
  if (!conn) return { error: "No Google OAuth connection found for this agent" };

  const bindingId = getBindingId(conn);
  if (!bindingId) return { error: "Google connection has no binding ID" };

  const now = new Date();
  const weekLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const maxResults = args.max_results || 10;

  const calendarUrl =
    `https://www.googleapis.com/calendar/v3/calendars/primary/events` +
    `?timeMin=${now.toISOString()}` +
    `&timeMax=${weekLater.toISOString()}` +
    `&maxResults=${maxResults}` +
    `&singleEvents=true` +
    `&orderBy=startTime`;

  const result = await executeViaBinding(context, bindingId, {
    url: calendarUrl,
    method: "GET",
  });

  if (result.error) return result;

  try {
    const body =
      typeof result.body === "string" ? JSON.parse(result.body) : result.body || result;
    const events = (body.items || []).map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      location: e.location,
      status: e.status,
    }));
    return { events, count: events.length };
  } catch {
    return result;
  }
}

async function executeCalendarCreate(args, context) {
  const conn = await getGoogleConnection(context);
  if (!conn) return { error: "No Google OAuth connection found for this agent" };

  const bindingId = getBindingId(conn);
  if (!bindingId) return { error: "Google connection has no binding ID" };

  if (!args.summary || !args.start || !args.end) {
    return { error: "summary, start, and end are required" };
  }

  const eventBody = {
    summary: args.summary,
    start: { dateTime: args.start },
    end: { dateTime: args.end },
  };
  if (args.description) eventBody.description = args.description;

  const calendarUrl =
    "https://www.googleapis.com/calendar/v3/calendars/primary/events";

  const result = await executeViaBinding(context, bindingId, {
    url: calendarUrl,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(eventBody),
  });

  if (result.error) return result;

  try {
    const body =
      typeof result.body === "string" ? JSON.parse(result.body) : result.body || result;
    return {
      id: body.id,
      summary: body.summary,
      start: body.start?.dateTime || body.start?.date,
      end: body.end?.dateTime || body.end?.date,
      htmlLink: body.htmlLink,
      status: body.status,
    };
  } catch {
    return result;
  }
}

async function executeGoogleSearch(args, context) {
  const cseId = context.env?.GOOGLE_CSE_ID || process.env.GOOGLE_CSE_ID;
  const apiKey = context.env?.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY;

  if (!cseId || !apiKey) {
    return { error: "GOOGLE_CSE_ID and GOOGLE_API_KEY environment variables are required" };
  }
  if (!args.query) return { error: "query is required" };

  const num = Math.min(Math.max(args.num || 5, 1), 10);
  const searchUrl =
    `https://www.googleapis.com/customsearch/v1` +
    `?key=${encodeURIComponent(apiKey)}` +
    `&cx=${encodeURIComponent(cseId)}` +
    `&q=${encodeURIComponent(args.query)}` +
    `&num=${num}`;

  try {
    const resp = await httpRequest(searchUrl, "GET", {});
    if (resp.status >= 400) {
      const data = JSON.parse(resp.text);
      return { error: `Google Search failed (${resp.status}): ${data.error?.message || resp.text.slice(0, 300)}` };
    }
    const data = JSON.parse(resp.text);
    const results = (data.items || []).map((item) => ({
      title: item.title,
      link: item.link,
      snippet: item.snippet,
    }));
    return { results, total: data.searchInformation?.totalResults };
  } catch (e) {
    return { error: `Google Search error: ${e.message}` };
  }
}

async function execute(toolName, args, context) {
  try {
    switch (toolName) {
      case "google_calendar_list":
        return await executeCalendarList(args, context);
      case "google_calendar_create":
        return await executeCalendarCreate(args, context);
      case "google_search":
        return await executeGoogleSearch(args, context);
      default:
        return { error: `Unknown Google tool: ${toolName}` };
    }
  } catch (e) {
    return { error: `Google tool error: ${e.message}` };
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
