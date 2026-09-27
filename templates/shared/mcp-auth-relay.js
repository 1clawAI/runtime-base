#!/usr/bin/env node
"use strict";

/**
 * Loopback relay that puts a *live* agent JWT on every MCP request.
 *
 * Hermes' MCP client is configured once, at startup, from a config file that
 * contains a literal `Authorization: Bearer <jwt>` (see
 * buildHermesMcpServerEntry in 1claw-hermes). That JWT is the runtime's ~2h
 * agent token. When it expires, every MCP call 401s, Hermes parks the server
 * after three attempts, and the agent quietly loses the entire 1claw toolset —
 * while still answering, still sounding confident, and with nothing in the UI
 * to say what happened. The only remedy the user had was to restart the
 * runtime, which is the thing we are trying to stop asking them to do.
 *
 * A bearer baked into a config file cannot be refreshed. So don't bake one in:
 * `hermes-agent-start.sh` points ONECLAW_MCP_URL at this relay before writing
 * that config, and the relay replaces the Authorization header on the way past
 * with whatever getAgentToken() currently holds — which agent-token.js keeps
 * renewed. Hermes' config never changes and never needs to.
 *
 * Loopback only. It adds no reachable surface: it listens on 127.0.0.1, and the
 * credential it attaches is one the container already has.
 *
 * Env:
 *   ONECLAW_MCP_UPSTREAM_URL  real MCP endpoint (default https://mcp.1claw.co/mcp)
 *   ONECLAW_MCP_RELAY_PORT    loopback port (default 8766)
 *   ONECLAW_VAULT_ID          sent as X-Vault-ID when the caller omits it
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

const { getAgentToken, startAgentTokenRenewal } = require("./agent-token.js");

const UPSTREAM = (
  process.env.ONECLAW_MCP_UPSTREAM_URL || "https://mcp.1claw.co/mcp"
).replace(/\/+$/, "");
const PORT = parseInt(process.env.ONECLAW_MCP_RELAY_PORT || "8766", 10);
const VAULT_ID = process.env.ONECLAW_VAULT_ID || "";

/**
 * Headers that must not be forwarded.
 *
 * `authorization` because replacing it is the whole point. `host` because it
 * would name the loopback listener rather than the upstream, and TLS/SNI and
 * most routers key off it. The hop-by-hop set because they describe this
 * connection, not the next one.
 */
const DROP_HEADERS = new Set([
  "authorization",
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

function forwardHeaders(incoming) {
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (!DROP_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  const token = getAgentToken();
  if (token) out.Authorization = `Bearer ${token}`;
  if (VAULT_ID && !out["x-vault-id"] && !out["X-Vault-ID"]) {
    out["X-Vault-ID"] = VAULT_ID;
  }
  return out;
}

const upstreamUrl = new URL(UPSTREAM);
const lib = upstreamUrl.protocol === "https:" ? https : http;

/**
 * The upstream path for an incoming request.
 *
 * The relay stands in for exactly one endpoint, and it is *addressed* at the
 * same path it forwards to — ONECLAW_MCP_URL becomes
 * `http://127.0.0.1:8766/mcp` and the upstream is `https://mcp.1claw.co/mcp`.
 * Appending the incoming path to the upstream path, which is the obvious thing
 * to write, therefore produces `/mcp/mcp` and 404s every call. The incoming
 * path is ignored; only its query string carries over.
 */
function upstreamPathFor(reqUrl) {
  const q = typeof reqUrl === "string" ? reqUrl.indexOf("?") : -1;
  const search = q >= 0 ? reqUrl.slice(q) : upstreamUrl.search;
  return upstreamUrl.pathname + search;
}

const server = http.createServer((req, res) => {
  // A relay with no credential to attach would forward an unauthenticated
  // request and get an opaque 401 from upstream. Say what actually happened.
  if (!getAgentToken()) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message:
            "No agent token available in this runtime — MCP cannot be authenticated. " +
            "Check that ONECLAW_AGENT_TOKEN was injected at start.",
        },
      })
    );
    return;
  }

  const upstreamReq = lib.request(
    {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || (upstreamUrl.protocol === "https:" ? 443 : 80),
      path: upstreamPathFor(req.url),
      method: req.method,
      headers: forwardHeaders(req.headers),
      // MCP turns can be long and may stream; this must outlast them rather
      // than cutting a tool call off mid-flight.
      timeout: 300_000,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
      upstreamRes.on("error", () => {
        try {
          res.end();
        } catch {
          /* client already gone */
        }
      });
    }
  );

  upstreamReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    res.end(
      JSON.stringify({ error: { message: `MCP relay upstream error: ${err.message}` } })
    );
  });
  upstreamReq.on("timeout", () => upstreamReq.destroy());

  // Piped, not buffered: an MCP response may be an SSE stream, and buffering
  // would turn live tool progress into one delivery at the end.
  req.pipe(upstreamReq);
});

server.on("error", (err) => {
  console.error(`[mcp-relay] listen error: ${err.message}`);
  process.exit(1);
});

if (require.main === module) {
  // The relay is the longest-lived process that needs a valid token, so it
  // owns renewal for this container's MCP path.
  startAgentTokenRenewal();

  server.listen(PORT, "127.0.0.1", () => {
    console.error(`[mcp-relay] 127.0.0.1:${PORT} → ${UPSTREAM} (live agent JWT per request)`);
  });
}

module.exports = { forwardHeaders, DROP_HEADERS, upstreamPathFor };
