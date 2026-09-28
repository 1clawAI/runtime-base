"use strict";
/**
 * Loopback relay that gives Hermes a working Anthropic credential without
 * ever storing one.
 *
 * Hermes reads `ANTHROPIC_API_KEY` once, at start. A federated Anthropic
 * token is short-lived by design — that is the point of minting one instead
 * of keeping a key on disk — so a value injected at boot is wrong within the
 * hour, and no sibling process can reach into Hermes to update it.
 *
 * Same answer as `mcp-auth-relay.js`: point the framework at 127.0.0.1 and
 * attach the current credential per request. Hermes then reads one value
 * that never changes (a base URL), and the thing that expires is handled
 * where it can be.
 *
 * Loopback only. It adds no reachable surface: it listens on 127.0.0.1, and
 * the token it attaches is minted from this runtime's own agent identity, so
 * nothing outside the container can obtain one through it.
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

const { getAnthropicToken } = require("./anthropic-oidc.js");

const ANTHROPIC_UPSTREAM = "https://api.anthropic.com";
const PORT = parseInt(process.env.ONECLAW_ANTHROPIC_RELAY_PORT || "8767", 10);

const upstreamUrl = new URL(ANTHROPIC_UPSTREAM);
const lib = upstreamUrl.protocol === "https:" ? https : http;

/**
 * Headers that must not be forwarded.
 *
 * `x-api-key` and `authorization` because replacing them is the whole point:
 * Hermes sends whatever placeholder it was configured with, and letting that
 * travel alongside ours means a stale value can win depending on upstream
 * precedence — a 401 that reads like a bad credential rather than a wrong
 * one. The rest describe this connection, not the next one.
 */
const DROP_HEADERS = [
  "x-api-key",
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
];

/**
 * How the minted token is presented.
 *
 * An `sk-ant-oat01-…` from the OAuth exchange is a bearer token, not an
 * `x-api-key`. Anthropic accepts both header styles for different credential
 * kinds, and sending an OAuth token as an API key is a 401 that looks like a
 * bad credential instead of a wrong shape.
 */
function authHeadersFor(token) {
  return { authorization: `Bearer ${token}` };
}

/** Preserve the path and query exactly; the upstream has no path prefix. */
function upstreamPathFor(reqUrl) {
  return typeof reqUrl === "string" && reqUrl ? reqUrl : "/";
}

function forwardHeaders(incoming) {
  const out = {};
  for (const [k, v] of Object.entries(incoming || {})) {
    if (DROP_HEADERS.includes(k.toLowerCase())) continue;
    out[k] = v;
  }
  out.host = upstreamUrl.host;
  return out;
}

function createRelay() {
  return http.createServer(async (req, res) => {
    let token;
    try {
      token = await getAnthropicToken();
    } catch (err) {
      // Say what actually happened. Forwarding unauthenticated would return
      // an opaque 401 from Anthropic and send the reader looking at their
      // model configuration.
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            type: "oneclaw_federation_error",
            message: `Could not mint an Anthropic token: ${err.message}`,
          },
        })
      );
      return;
    }

    const upstreamReq = lib.request(
      {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || 443,
        method: req.method,
        path: upstreamPathFor(req.url),
        headers: { ...forwardHeaders(req.headers), ...authHeadersFor(token) },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );

    upstreamReq.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { type: "oneclaw_relay_error", message: `Anthropic unreachable: ${err.message}` },
        })
      );
    });

    req.pipe(upstreamReq);
  });
}

function startAnthropicRelay(port = PORT) {
  const server = createRelay();
  server.listen(port, "127.0.0.1", () => {
    console.log(`[anthropic-relay] loopback on 127.0.0.1:${port} → ${ANTHROPIC_UPSTREAM}`);
  });
  return server;
}

module.exports = {
  ANTHROPIC_UPSTREAM,
  DROP_HEADERS,
  authHeadersFor,
  upstreamPathFor,
  forwardHeaders,
  createRelay,
  startAnthropicRelay,
};

if (require.main === module) startAnthropicRelay();
