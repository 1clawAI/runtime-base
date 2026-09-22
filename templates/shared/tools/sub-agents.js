"use strict";

/**
 * Sub-agent framework tool for 1Claw runtimes.
 *
 * Enables inter-agent communication: discovery, task delegation,
 * org agent listing, delegation status checking, and automation triggering.
 */

const { URL } = require("url");
const { apiAuthHeaders } = require("../agent-token.js");

// ---------------------------------------------------------------------------
// HTTP helper (Node built-ins only)
// ---------------------------------------------------------------------------

function httpRequest(url, method, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? require("https") : require("http");
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: method || "GET",
      headers: headers || {},
    };

    const timeout = timeoutMs || 30000;
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(raw);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, headers: res.headers, body: raw, json });
      });
    });

    req.setTimeout(timeout, () => {
      req.destroy(new Error("request timeout"));
    });
    req.on("error", reject);

    if (body != null) {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      req.write(payload);
    }
    req.end();
  });
}

function authHeaders(token) {
  const h = { "Content-Type": "application/json", ...apiAuthHeaders(token) };
  return h;
}

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI function-calling schema)
// ---------------------------------------------------------------------------

const definitions = [
  {
    type: "function",
    function: {
      name: "discover_agents",
      description:
        "Search the public agent directory for agents with specific capabilities or tags.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Free-text search query for agent names/descriptions.",
          },
          tags: {
            type: "string",
            description: "Comma-separated tags to filter agents by.",
          },
          page: {
            type: "number",
            description: "Page number for pagination (1-based).",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delegate_task",
      description:
        "Send a task to another agent via chat and optionally wait for its response. Core inter-agent communication primitive.",
      parameters: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: "Target agent's UUID.",
          },
          task: {
            type: "string",
            description: "The task or message to send to the target agent.",
          },
          wait_for_response: {
            type: "boolean",
            description: "Whether to wait for the LLM response (default: true).",
          },
          timeout_seconds: {
            type: "number",
            description: "Max seconds to wait for response (default: 30).",
          },
          model: {
            type: "string",
            description: "LLM model for the target agent to use.",
          },
          provider: {
            type: "string",
            description: "LLM provider for the target agent to use.",
          },
          execution_mode: {
            type: "string",
            description:
              'Execution mode: "caller" (default, use your credentials) or "target" (execute with target agent\'s config and tools).',
            enum: ["caller", "target"],
          },
        },
        required: ["agent_id", "task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_my_sub_agents",
      description:
        "List agents in the same organization that could serve as sub-agents, including delegation authorization status.",
      parameters: {
        type: "object",
        properties: {
          tag_filter: {
            type: "string",
            description:
              'Tag to filter sub-agents by (default: "sub-agent").',
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_delegation_status",
      description:
        "Check which agents you are authorized to delegate to, and what tools/limits apply.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_sub_task",
      description:
        "Trigger an automation workflow run, optionally passing context data.",
      parameters: {
        type: "object",
        properties: {
          automation_id: {
            type: "string",
            description: "The UUID of the automation to trigger.",
          },
          context: {
            type: "object",
            description: "Context data to pass to the automation run.",
          },
        },
        required: ["automation_id"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function discoverAgents(args, context) {
  const params = new URLSearchParams();
  if (args.query) params.set("q", args.query);
  if (args.tags) params.set("tags", args.tags);
  if (args.page) params.set("page", String(args.page));

  const qs = params.toString();
  const url = `${context.baseUrl}/v1/agents/directory${qs ? "?" + qs : ""}`;

  const res = await httpRequest(url, "GET", authHeaders(context.agentToken));

  if (res.status !== 200) {
    return { error: `Directory search failed (${res.status})`, detail: res.body };
  }

  const agents = Array.isArray(res.json) ? res.json : res.json?.agents || [];
  return agents.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.public_description || a.description || "",
    tags: a.public_tags || a.tags || [],
    capabilities: a.capabilities || [],
    a2a_url: a.a2a_url || null,
    mcp_url: a.mcp_url || null,
  }));
}

async function delegateTask(args, context) {
  const targetId = args.agent_id;
  if (!targetId) return { error: "agent_id is required" };
  if (!args.task) return { error: "task is required" };

  const waitForResponse = args.wait_for_response !== false;
  const timeoutMs = (args.timeout_seconds || 30) * 1000;

  const url = `${context.baseUrl}/v1/agents/${targetId}/chat`;
  const body = { message: args.task, mode: "llm" };
  if (args.model) body.model = args.model;
  if (args.provider) body.provider = args.provider;
  if (args.execution_mode) body.execution_mode = args.execution_mode;

  const currentDepth = parseInt(process.env.ONECLAW_DELEGATION_DEPTH || "0", 10);
  const headers = authHeaders(context.agentToken);
  headers["X-Delegation-Depth"] = String(currentDepth + 1);

  if (!waitForResponse) {
    const res = await httpRequest(url, "POST", headers, body, 10000);
    if (res.status === 403) {
      const detail = res.json?.detail || res.body;
      return {
        error: "Delegation not authorized",
        detail: `You are not authorized to delegate tasks to agent ${targetId}. Ensure a delegation exists granting you access. Server response: ${detail}`,
      };
    }
    if (res.status >= 400) {
      return { error: `Chat request failed (${res.status})`, detail: res.body };
    }
    const conversationId = res.json?.conversation_id || null;
    return { status: "sent", conversation_id: conversationId };
  }

  const result = await collectChatResponse(url, headers, body, timeoutMs);
  return result;
}

/**
 * Sends a chat POST and collects the SSE stream into a single response.
 * Extracts the assistant message content and conversation_id.
 */
function collectChatResponse(url, headers, body, timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? require("https") : require("http");

    const payload = JSON.stringify(body);
    headers["Content-Length"] = Buffer.byteLength(payload);

    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "POST",
      headers,
    };

    let conversationId = null;
    let content = "";
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        status: "timeout",
        conversation_id: conversationId,
        partial_response: content || undefined,
      });
      req.destroy();
    }, timeoutMs);

    const req = lib.request(opts, (res) => {
      if (res.statusCode === 403) {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          clearTimeout(timer);
          const errBody = Buffer.concat(chunks).toString("utf8");
          let detail = errBody;
          try { detail = JSON.parse(errBody).detail || errBody; } catch { /* keep raw */ }
          finish({
            error: "Delegation not authorized",
            detail: `You are not authorized to delegate to this agent. Ensure a delegation exists granting access. Server: ${detail}`,
          });
        });
        return;
      }

      if (res.statusCode >= 400) {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          clearTimeout(timer);
          const errBody = Buffer.concat(chunks).toString("utf8");
          finish({ error: `Chat request failed (${res.statusCode})`, detail: errBody });
        });
        return;
      }

      // Parse SSE events
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            clearTimeout(timer);
            finish({ conversation_id: conversationId, response: content });
            return;
          }
          try {
            const evt = JSON.parse(data);
            if (evt.conversation_id) conversationId = evt.conversation_id;
            // Accumulate delta content from SSE chunks
            const delta =
              evt.choices?.[0]?.delta?.content ||
              evt.delta?.content ||
              evt.content ||
              "";
            if (delta) content += delta;
          } catch {
            /* skip malformed event lines */
          }
        }
      });

      res.on("end", () => {
        clearTimeout(timer);
        finish({ conversation_id: conversationId, response: content });
      });
    });

    req.on("error", (err) => {
      clearTimeout(timer);
      finish({ error: `Request error: ${err.message}`, conversation_id: conversationId });
    });

    req.write(payload);
    req.end();
  });
}

async function listMySubAgents(args, context) {
  const tag = args.tag_filter || "sub-agent";
  const results = [];

  // Try the public directory filtered by tag
  const dirUrl = `${context.baseUrl}/v1/agents/directory?tags=${encodeURIComponent(tag)}`;
  const dirRes = await httpRequest(dirUrl, "GET", authHeaders(context.agentToken));
  if (dirRes.status === 200) {
    const dirAgents = Array.isArray(dirRes.json) ? dirRes.json : dirRes.json?.agents || [];
    for (const a of dirAgents) {
      results.push({
        id: a.id,
        name: a.name,
        description: a.public_description || a.description || "",
        tags: a.public_tags || a.tags || [],
        source: "directory",
      });
    }
  }

  // Also fetch org-scoped agent list (authenticated)
  if (context.agentToken) {
    const orgUrl = `${context.baseUrl}/v1/agents`;
    const orgRes = await httpRequest(orgUrl, "GET", authHeaders(context.agentToken));
    if (orgRes.status === 200) {
      const orgAgents = Array.isArray(orgRes.json) ? orgRes.json : orgRes.json?.agents || [];
      const existingIds = new Set(results.map((r) => r.id));
      for (const a of orgAgents) {
        if (existingIds.has(a.id)) continue;
        results.push({
          id: a.id,
          name: a.name,
          description: a.description || "",
          tags: a.tags || [],
          source: "org",
        });
      }
    }
  }

  // Fetch effective delegations and merge status
  const agentId = process.env.ONECLAW_AGENT_ID;
  if (agentId && context.agentToken) {
    const delegUrl = `${context.baseUrl}/v1/agents/${agentId}/delegations/effective`;
    const delegRes = await httpRequest(delegUrl, "GET", authHeaders(context.agentToken));
    if (delegRes.status === 200) {
      const delegations = delegRes.json?.delegations || [];
      const delegMap = new Map();
      for (const d of delegations) {
        delegMap.set(d.delegate_id, d);
      }

      for (const agent of results) {
        const deleg = delegMap.get(agent.id);
        if (deleg) {
          agent.delegation = {
            authorized: true,
            mode: deleg.delegation_mode || "caller",
            allowed_tools: deleg.allowed_tools || [],
            remaining_daily: deleg.max_daily_delegations != null
              ? Math.max(0, deleg.max_daily_delegations - (deleg.delegations_today || 0))
              : null,
          };
        } else {
          agent.delegation = { authorized: false };
        }
      }
    }
  }

  return results;
}

async function getDelegationStatus(_args, context) {
  const agentId = process.env.ONECLAW_AGENT_ID;
  if (!agentId) {
    return { error: "ONECLAW_AGENT_ID environment variable is not set" };
  }

  const url = `${context.baseUrl}/v1/agents/${agentId}/delegations/effective`;
  const res = await httpRequest(url, "GET", authHeaders(context.agentToken));

  if (res.status !== 200) {
    return { error: `Failed to fetch delegation status (${res.status})`, detail: res.body };
  }

  const delegations = res.json?.delegations || [];
  return {
    agent_id: agentId,
    delegations: delegations.map((d) => ({
      delegate_id: d.delegate_id,
      delegate_name: d.delegate_name || null,
      delegation_mode: d.delegation_mode || "caller",
      allowed_tools: d.allowed_tools || [],
      blocked_tools: d.blocked_tools || [],
      max_daily_delegations: d.max_daily_delegations || null,
      remaining_today: d.max_daily_delegations != null
        ? Math.max(0, d.max_daily_delegations - (d.delegations_today || 0))
        : null,
      max_depth: d.max_depth || 3,
      expires_at: d.expires_at || null,
    })),
  };
}

async function createSubTask(args, context) {
  const automationId = args.automation_id;
  if (!automationId) return { error: "automation_id is required" };

  const url = `${context.baseUrl}/v1/automations/${automationId}/trigger`;
  const body = args.context ? { context: args.context } : {};

  const res = await httpRequest(url, "POST", authHeaders(context.agentToken), body);

  if (res.status >= 400) {
    return { error: `Trigger failed (${res.status})`, detail: res.body };
  }

  return res.json || { status: "triggered" };
}

// ---------------------------------------------------------------------------
// Module interface
// ---------------------------------------------------------------------------

async function execute(toolName, args, context) {
  switch (toolName) {
    case "discover_agents":
      return discoverAgents(args || {}, context);
    case "delegate_task":
      return delegateTask(args || {}, context);
    case "list_my_sub_agents":
      return listMySubAgents(args || {}, context);
    case "get_delegation_status":
      return getDelegationStatus(args || {}, context);
    case "create_sub_task":
      return createSubTask(args || {}, context);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

function isAvailable(_env) {
  return true;
}

module.exports = { definitions, execute, isAvailable };
