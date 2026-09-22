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

async function getGitHubConnection(context) {
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
    const github = Array.isArray(connections)
      ? connections.find(
          (c) =>
            c.provider === "github" ||
            c.provider_slug === "github" ||
            c.oauth2_provider === "github",
        )
      : null;

    if (github) {
      _connectionCache = github;
      _connectionCacheExpiry = now + 5 * 60 * 1000;
    }
    return github || null;
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
      name: "github_search_repos",
      description:
        "Search GitHub repositories by keyword. Returns matching repos with name, description, stars, and URL.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (e.g. 'machine learning python')" },
          sort: {
            type: "string",
            enum: ["stars", "forks", "updated", "help-wanted-issues"],
            description: "Sort field (default: best match)",
          },
          per_page: {
            type: "number",
            description: "Results per page (1-30, default 10)",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_list_issues",
      description: "List issues for a GitHub repository.",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Repository owner (user or org)" },
          repo: { type: "string", description: "Repository name" },
          state: {
            type: "string",
            enum: ["open", "closed", "all"],
            description: "Issue state filter (default: open)",
          },
          per_page: {
            type: "number",
            description: "Results per page (1-30, default 10)",
          },
        },
        required: ["owner", "repo"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_create_issue",
      description: "Create a new issue in a GitHub repository.",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Repository owner (user or org)" },
          repo: { type: "string", description: "Repository name" },
          title: { type: "string", description: "Issue title" },
          body: { type: "string", description: "Issue body (Markdown supported)" },
        },
        required: ["owner", "repo", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_get_file",
      description:
        "Read the contents of a file from a GitHub repository. Returns the decoded text content.",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Repository owner (user or org)" },
          repo: { type: "string", description: "Repository name" },
          path: { type: "string", description: "File path within the repository (e.g. 'src/index.ts')" },
          ref: {
            type: "string",
            description: "Branch, tag, or commit SHA (default: repo default branch)",
          },
        },
        required: ["owner", "repo", "path"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeSearchRepos(args, context) {
  const conn = await getGitHubConnection(context);
  if (!conn) return { error: "No GitHub OAuth connection found for this agent" };

  const bindingId = getBindingId(conn);
  if (!bindingId) return { error: "GitHub connection has no binding ID" };

  if (!args.query) return { error: "query is required" };

  const perPage = Math.min(Math.max(args.per_page || 10, 1), 30);
  let searchUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(args.query)}&per_page=${perPage}`;
  if (args.sort) searchUrl += `&sort=${encodeURIComponent(args.sort)}`;

  const result = await executeViaBinding(context, bindingId, {
    url: searchUrl,
    method: "GET",
    headers: { "User-Agent": "1claw-runtime" },
  });

  if (result.error) return result;

  try {
    const body =
      typeof result.body === "string" ? JSON.parse(result.body) : result.body || result;
    const repos = (body.items || []).map((r) => ({
      full_name: r.full_name,
      description: r.description,
      html_url: r.html_url,
      stargazers_count: r.stargazers_count,
      language: r.language,
      updated_at: r.updated_at,
    }));
    return { repos, total_count: body.total_count };
  } catch {
    return result;
  }
}

async function executeListIssues(args, context) {
  const conn = await getGitHubConnection(context);
  if (!conn) return { error: "No GitHub OAuth connection found for this agent" };

  const bindingId = getBindingId(conn);
  if (!bindingId) return { error: "GitHub connection has no binding ID" };

  if (!args.owner || !args.repo) return { error: "owner and repo are required" };

  const state = args.state || "open";
  const perPage = Math.min(Math.max(args.per_page || 10, 1), 30);
  const issuesUrl =
    `https://api.github.com/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/issues` +
    `?state=${state}&per_page=${perPage}`;

  const result = await executeViaBinding(context, bindingId, {
    url: issuesUrl,
    method: "GET",
    headers: { "User-Agent": "1claw-runtime" },
  });

  if (result.error) return result;

  try {
    const body =
      typeof result.body === "string" ? JSON.parse(result.body) : result.body || result;
    const issues = (Array.isArray(body) ? body : []).map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      html_url: i.html_url,
      user: i.user?.login,
      labels: (i.labels || []).map((l) => l.name),
      created_at: i.created_at,
    }));
    return { issues, count: issues.length };
  } catch {
    return result;
  }
}

async function executeCreateIssue(args, context) {
  const conn = await getGitHubConnection(context);
  if (!conn) return { error: "No GitHub OAuth connection found for this agent" };

  const bindingId = getBindingId(conn);
  if (!bindingId) return { error: "GitHub connection has no binding ID" };

  if (!args.owner || !args.repo || !args.title) {
    return { error: "owner, repo, and title are required" };
  }

  const issueUrl =
    `https://api.github.com/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/issues`;

  const issueBody = { title: args.title };
  if (args.body) issueBody.body = args.body;

  const result = await executeViaBinding(context, bindingId, {
    url: issueUrl,
    method: "POST",
    headers: {
      "User-Agent": "1claw-runtime",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(issueBody),
  });

  if (result.error) return result;

  try {
    const body =
      typeof result.body === "string" ? JSON.parse(result.body) : result.body || result;
    return {
      number: body.number,
      title: body.title,
      html_url: body.html_url,
      state: body.state,
    };
  } catch {
    return result;
  }
}

async function executeGetFile(args, context) {
  const conn = await getGitHubConnection(context);
  if (!conn) return { error: "No GitHub OAuth connection found for this agent" };

  const bindingId = getBindingId(conn);
  if (!bindingId) return { error: "GitHub connection has no binding ID" };

  if (!args.owner || !args.repo || !args.path) {
    return { error: "owner, repo, and path are required" };
  }

  let fileUrl =
    `https://api.github.com/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/contents/${args.path}`;
  if (args.ref) fileUrl += `?ref=${encodeURIComponent(args.ref)}`;

  const result = await executeViaBinding(context, bindingId, {
    url: fileUrl,
    method: "GET",
    headers: { "User-Agent": "1claw-runtime" },
  });

  if (result.error) return result;

  try {
    const body =
      typeof result.body === "string" ? JSON.parse(result.body) : result.body || result;
    let content = body.content || "";
    if (body.encoding === "base64" && content) {
      content = Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8");
    }
    return {
      name: body.name,
      path: body.path,
      size: body.size,
      sha: body.sha,
      content,
    };
  } catch {
    return result;
  }
}

async function execute(toolName, args, context) {
  try {
    switch (toolName) {
      case "github_search_repos":
        return await executeSearchRepos(args, context);
      case "github_list_issues":
        return await executeListIssues(args, context);
      case "github_create_issue":
        return await executeCreateIssue(args, context);
      case "github_get_file":
        return await executeGetFile(args, context);
      default:
        return { error: `Unknown GitHub tool: ${toolName}` };
    }
  } catch (e) {
    return { error: `GitHub tool error: ${e.message}` };
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
