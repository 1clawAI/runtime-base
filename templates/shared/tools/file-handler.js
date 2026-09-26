#!/usr/bin/env node
/**
 * File Handler Tool
 *
 * Process files/images sent by users in channel messages.
 * - analyze_image: Send image URL to vision-capable LLM for description
 * - read_url: Fetch and extract text content from a URL
 */
"use strict";

const http = require("http");
const https = require("https");
const dns = require("dns").promises;
const net = require("net");
const { URL } = require("url");

/**
 * PROMPTSSRF-L1. `read_url` used to reject exactly three literal hostnames —
 * `localhost`, `127.0.0.1`, `0.0.0.0` — which is not an SSRF guard. `127.1`,
 * `[::1]`, `2130706433`, any private address, and above all
 * `169.254.169.254` (cloud metadata) all went straight through, as did any
 * DNS name resolving to them. Redirects were followed with no re-check and
 * no hop limit, so a public URL could bounce to loopback in one hop.
 *
 * The guard itself is pre-existing; what changed is that the research prompt
 * now actively pushes the agent to `read_url` its search results, so the rate
 * at which it fetches attacker-influenced pages went up and with it the value
 * of prompt-injection-driven exfil.
 *
 * Residual, stated rather than hidden: this resolves and validates, then
 * connects by hostname, so a DNS rebind between the two is still possible.
 * Closing that needs connecting to the validated IP with an explicit Host
 * header, which is a larger change than this finding warrants.
 */
const MAX_REDIRECTS = 5;

function isBlockedIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true; //           0.0.0.0/8  "this host"
  if (a === 10) return true; //          10/8       private
  if (a === 127) return true; //         127/8      loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true; //           169.254/16 link-local, incl. metadata
  if (a === 172 && b >= 16 && b <= 31) return true; //  172.16/12  private
  if (a === 192 && b === 168) return true; //           192.168/16 private
  if (a === 192 && b === 0) return true; //             192.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a >= 224) return true; //          224/4 multicast, 240/4 reserved
  return false;
}

function isBlockedIP(ip) {
  if (net.isIPv4(ip)) return isBlockedIPv4(ip);
  if (!net.isIPv6(ip)) return true;
  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible forms.
  const mapped = lower.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4(mapped[1]);
  if (lower === "::1" || lower === "::") return true;
  const head = lower.split(":")[0];
  if (/^f[cd]/.test(head)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(head)) return true; // fe80::/10 link-local
  if (head === "ff00" || /^ff/.test(head)) return true; // multicast
  return false;
}

/** Throws if `url` names a host that resolves anywhere it should not. */
async function assertPublicDestination(url) {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("Only http and https URLs are supported");
  }

  // A literal address needs no lookup — and must not get one, or a hostile
  // resolver could answer for it.
  const literal = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(literal)) {
    if (isBlockedIP(literal)) {
      throw new Error(`Refusing to fetch a private or loopback address (${literal})`);
    }
    return;
  }

  let addrs;
  try {
    addrs = await dns.lookup(u.hostname, { all: true });
  } catch {
    throw new Error(`Could not resolve ${u.hostname}`);
  }
  if (!addrs.length) throw new Error(`Could not resolve ${u.hostname}`);
  for (const { address } of addrs) {
    if (isBlockedIP(address)) {
      throw new Error(
        `Refusing to fetch ${u.hostname}: it resolves to a private or loopback address`,
      );
    }
  }
}

const analyzeImageDef = {
  type: "function",
  function: {
    name: "analyze_image",
    description:
      "Analyze an image by URL using a vision-capable LLM. " +
      "Returns a description or analysis of the image contents.",
    parameters: {
      type: "object",
      properties: {
        image_url: {
          type: "string",
          description: "URL of the image to analyze",
        },
        question: {
          type: "string",
          description:
            "Optional question about the image (default: describe the image)",
        },
      },
      required: ["image_url"],
    },
  },
};

const readUrlDef = {
  type: "function",
  function: {
    name: "read_url",
    description:
      "Fetch a public URL and extract its text content. Use it to actually " +
      "read a web page, article, documentation, or API response — for example " +
      "to follow up on a web_search result and pull concrete details (facts, " +
      "contact info, specs, pricing) from the page itself. Returns the " +
      "extracted text.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL to fetch",
        },
        max_length: {
          type: "number",
          description: "Maximum characters to return (default 8000)",
        },
      },
      required: ["url"],
    },
  },
};

function isAvailable(_env) {
  return true;
}

function httpGet(url, headers = {}, timeoutMs = 15000, maxBytes = 512 * 1024, redirectsLeft = MAX_REDIRECTS) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === "https:" ? 443 : 80),
    path: u.pathname + u.search,
    method: "GET",
    headers: {
      "User-Agent": "1Claw-Runtime/1.0",
      Accept: "text/html,application/json,text/plain,*/*",
      ...headers,
    },
    timeout: timeoutMs,
  };

  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (resp) => {
      if (
        resp.statusCode >= 300 &&
        resp.statusCode < 400 &&
        resp.headers.location
      ) {
        // PROMPTSSRF-L1: a redirect is a new destination, so it gets the
        // same check as the first one — a public URL that bounces to
        // 169.254.169.254 was previously followed without question. The hop
        // limit stops a redirect loop from being a denial of service.
        resp.resume();
        const next = new URL(resp.headers.location, url).toString();
        if (redirectsLeft <= 0) {
          reject(new Error("Too many redirects"));
          return;
        }
        assertPublicDestination(next)
          .then(() => httpGet(next, headers, timeoutMs, maxBytes, redirectsLeft - 1))
          .then(resolve)
          .catch(reject);
        return;
      }

      const chunks = [];
      let size = 0;
      resp.on("data", (c) => {
        size += c.length;
        if (size <= maxBytes) chunks.push(c);
      });
      resp.on("end", () => {
        resolve({
          status: resp.statusCode || 0,
          text: Buffer.concat(chunks).toString("utf8"),
          contentType: resp.headers["content-type"] || "",
        });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("URL fetch timed out"));
    });
    req.end();
  });
}

function httpPostJson(url, headers, body, timeoutMs = 30000) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  const payload = JSON.stringify(body);
  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === "https:" ? 443 : 80),
    path: u.pathname + u.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...headers,
      "Content-Length": Buffer.byteLength(payload),
    },
    timeout: timeoutMs,
  };

  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (resp) => {
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () => {
        resolve({
          status: resp.statusCode || 0,
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("LLM vision request timed out"));
    });
    req.write(payload);
    req.end();
  });
}

function stripHtmlTags(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function resolveLlmUrl(env, context) {
  if (
    env.ONECLAW_SHROUD_ENABLED === "1" ||
    env.ONECLAW_SHROUD_ENABLED === "true"
  ) {
    return `${context.sidecarUrl}/v1/chat/completions`;
  }
  if (env.OPENAI_API_KEY) {
    return "https://api.openai.com/v1/chat/completions";
  }
  const shroud = (
    env.ONECLAW_SHROUD_URL || "https://shroud.1claw.co"
  ).replace(/\/$/, "");
  return `${shroud}/v1/chat/completions`;
}

function buildLlmAuthHeaders(env, context) {
  const headers = {};
  if (env.OPENAI_API_KEY && !(env.ONECLAW_SHROUD_ENABLED === "1" || env.ONECLAW_SHROUD_ENABLED === "true")) {
    headers.Authorization = `Bearer ${env.OPENAI_API_KEY}`;
  } else if (context.agentToken) {
    headers.Authorization = `Bearer ${context.agentToken}`;
    headers["X-Shroud-Provider"] = "openai";
    const apiKey = env.ONECLAW_AGENT_API_KEY || "";
    if (context.agentId && apiKey && !apiKey.startsWith("eyJ")) {
      headers["X-Shroud-Agent-Key"] = `${context.agentId}:${apiKey}`;
    }
  }
  return headers;
}

async function executeAnalyzeImage(args, context) {
  const imageUrl = (args.image_url || "").trim();
  if (!imageUrl) return { error: "image_url is required" };

  try {
    new URL(imageUrl);
  } catch {
    return { error: "Invalid image URL" };
  }

  const question = args.question || "Describe this image in detail.";
  const env = context.env || process.env;
  const llmUrl = resolveLlmUrl(env, context);
  const headers = buildLlmAuthHeaders(env, context);
  const model = env.ONECLAW_VISION_MODEL || env.ONECLAW_DEFAULT_MODEL || "gpt-4o-mini";

  const resp = await httpPostJson(llmUrl, headers, {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: question },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    max_tokens: 1024,
  });

  if (resp.status >= 400) {
    return { error: `Vision analysis failed (${resp.status}): ${resp.text.slice(0, 200)}` };
  }

  try {
    const data = JSON.parse(resp.text);
    const content = data?.choices?.[0]?.message?.content || "";
    return { analysis: content, image_url: imageUrl, model };
  } catch {
    return { error: "Invalid response from vision API" };
  }
}

async function executeReadUrl(args, _context) {
  const url = (args.url || "").trim();
  if (!url) return { error: "url is required" };

  try {
    new URL(url);
  } catch {
    return { error: "Invalid URL format" };
  }
  try {
    await assertPublicDestination(url);
  } catch (e) {
    return { error: e.message };
  }

  const maxLength = Math.min(args.max_length || 8000, 50000);

  try {
    const resp = await httpGet(url);

    if (resp.status >= 400) {
      return { error: `URL returned ${resp.status}`, url };
    }

    let text = resp.text;
    if (resp.contentType.includes("text/html")) {
      text = stripHtmlTags(text);
    }

    if (text.length > maxLength) {
      text = text.slice(0, maxLength) + "\n...(truncated)";
    }

    return {
      content: text,
      url,
      content_type: resp.contentType,
      length: text.length,
    };
  } catch (e) {
    return { error: `Failed to fetch URL: ${e.message}`, url };
  }
}

async function execute(name, args, context) {
  switch (name) {
    case "analyze_image":
      return executeAnalyzeImage(args, context);
    case "read_url":
      return executeReadUrl(args, context);
    default:
      return { error: `Unknown file handler tool: ${name}` };
  }
}

module.exports = {
  assertPublicDestination,
  isBlockedIP,
  definitions: [analyzeImageDef, readUrlDef],
  isAvailable,
  execute,
};
