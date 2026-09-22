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
const { URL } = require("url");

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
      "Fetch a URL and extract its text content. " +
      "Useful for reading web pages, API responses, or documents.",
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

function httpGet(url, headers = {}, timeoutMs = 15000, maxBytes = 512 * 1024) {
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
        httpGet(resp.headers.location, headers, timeoutMs, maxBytes)
          .then(resolve)
          .catch(reject);
        resp.resume();
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
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return { error: "Only http and https URLs are supported" };
    }
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "0.0.0.0") {
      return { error: "Local URLs are not allowed" };
    }
  } catch {
    return { error: "Invalid URL format" };
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
  definitions: [analyzeImageDef, readUrlDef],
  isAvailable,
  execute,
};
