#!/usr/bin/env node
/**
 * Shared OpenAI-compatible image generation helper for runtime chat bridges.
 * Routes through Shroud sidecar (agent JWT billing) or direct provider API (user key).
 */
"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");

const SHROUD_ENABLED =
  process.env.ONECLAW_SHROUD_ENABLED === "1" ||
  process.env.ONECLAW_SHROUD_ENABLED === "true";

const {
  DEFAULT_IMAGE_MODEL,
  GPT_IMAGE_SIZES,
  LEGACY_DALLE3_SIZES,
  resolveImageModel,
  buildImageGenerationBody,
  stripDalle3OnlyFields,
  isUnsupportedStyleError,
  isUnsupportedResponseFormatError,
  isModelNotFoundError,
  formatModelNotFoundHint,
  extractImageResult,
} = require("./image-gen-request.js");
const { packageImageToolResult } = require("./generated-image-cache.js");

const DEFAULT_IMAGE_SIZE = process.env.ONECLAW_IMAGE_SIZE || "1024x1024";
const VALID_IMAGE_SIZES = GPT_IMAGE_SIZES.concat(LEGACY_DALLE3_SIZES);

const TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "generate_image",
    description:
      "Generate an image from a text prompt using OpenAI GPT Image (default gpt-image-2). " +
      "Returns a URL or inline base64 data URI. Use when the user asks for a picture, illustration, meme, or visual.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Detailed description of the image to generate",
        },
        size: {
          type: "string",
          enum: VALID_IMAGE_SIZES,
          description: "Image dimensions (default 1024x1024)",
        },
      },
      required: ["prompt"],
    },
  },
};

function resolveImageUpstream(provider, useOwnKey) {
  // Only OpenAI supports /v1/images/generations (DALL-E).
  // When user has their own OpenAI key, go direct; otherwise route through Shroud
  // which will use the vault-stored OpenAI key for the org.
  if (useOwnKey && provider === "openai") {
    return {
      url: "https://api.openai.com/v1/images/generations",
      via: "direct-openai",
    };
  }
  if (SHROUD_ENABLED) {
    return { url: "http://127.0.0.1:8082/v1/images/generations", via: "sidecar" };
  }
  const openaiBase = (process.env.OPENAI_BASE_URL || "").replace(/\/$/, "");
  if (openaiBase) {
    const path = openaiBase.endsWith("/v1")
      ? `${openaiBase}/images/generations`
      : `${openaiBase}/v1/images/generations`;
    return { url: path, via: "openai_base_url" };
  }
  const shroud = (process.env.ONECLAW_SHROUD_URL || "https://shroud.1claw.co").replace(/\/$/, "");
  return { url: `${shroud}/v1/images/generations`, via: "shroud" };
}

function httpPostJson(url, headers, body) {
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
    timeout: 120000,
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
      reject(new Error("image generation timeout"));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.size]
 * @param {string} [opts.provider]
 * @param {boolean} [opts.useOwnKey]
 * @param {() => Record<string,string>} opts.buildAuthHeaders
 */
async function executeGenerateImage(opts) {
  const prompt = (opts.prompt || "").trim();
  if (!prompt) return { error: "prompt is required" };

  const chatProvider = opts.provider || process.env.ONECLAW_DEFAULT_PROVIDER || "openai";
  const useOwnKey = Boolean(opts.useOwnKey);
  const upstream = resolveImageUpstream(chatProvider, useOwnKey);

  // DALL-E is OpenAI-specific — always use "openai" as the provider when routing
  // through Shroud/sidecar, regardless of the agent's chat LLM provider.
  const imageProvider =
    upstream.via === "sidecar" || upstream.via === "shroud" ? "openai" : chatProvider;

  const imageModel = resolveImageModel(process.env, DEFAULT_IMAGE_MODEL);
  const imageQuality = process.env.ONECLAW_IMAGE_QUALITY;
  let body = buildImageGenerationBody({
    model: imageModel,
    prompt,
    size: opts.size || DEFAULT_IMAGE_SIZE,
    quality: imageQuality,
  });

  try {
    let resp = await httpPostJson(upstream.url, opts.buildAuthHeaders(imageProvider), body);
    let data;
    try {
      data = JSON.parse(resp.text);
    } catch {
      return {
        error: `Invalid image API response (${upstream.via}): ${resp.text.slice(0, 300)}`,
      };
    }

    if (resp.status === 400) {
      const detail =
        data?.error?.message || data?.detail || data?.message || resp.text.slice(0, 300);
      if (
        isUnsupportedStyleError(detail) ||
        isUnsupportedResponseFormatError(detail)
      ) {
        body = stripDalle3OnlyFields(body);
        resp = await httpPostJson(upstream.url, opts.buildAuthHeaders(imageProvider), body);
        try {
          data = JSON.parse(resp.text);
        } catch {
          return {
            error: `Invalid image API response (${upstream.via}): ${resp.text.slice(0, 300)}`,
          };
        }
      } else if (isModelNotFoundError(detail)) {
        body = buildImageGenerationBody({
          model: DEFAULT_IMAGE_MODEL,
          prompt,
          size: opts.size || DEFAULT_IMAGE_SIZE,
          quality: imageQuality,
        });
        resp = await httpPostJson(upstream.url, opts.buildAuthHeaders(imageProvider), body);
        try {
          data = JSON.parse(resp.text);
        } catch {
          return {
            error: `Invalid image API response (${upstream.via}): ${resp.text.slice(0, 300)}`,
          };
        }
      }
    }

    // fall through to status handling below (re-parse avoided when not retried)
    if (resp.status >= 400) {
      const detail =
        data?.error?.message || data?.detail || data?.message || resp.text.slice(0, 300);
      if (resp.status === 401) {
        return {
          error:
            "Image generation authentication failed. " +
            "Dashboard → Runtimes → (your runtime) → Config → API Keys — save an OpenAI key at providers/openai/api-key. " +
            "Enable Shroud on your agent (Dashboard → Agents → Shroud LLM Proxy). " +
            "Stripe LLM billing covers chat only — GPT Image needs a real OpenAI key. " +
            "Do not use Runtime → Environment for API keys (blocked for security).",
        };
      }
      if (resp.status === 429) {
        return { error: "Image generation rate limited. Please wait a moment and try again." };
      }
      if (isModelNotFoundError(detail)) {
        return { error: formatModelNotFoundHint(imageModel) };
      }
      return { error: `Image generation failed (${resp.status}): ${detail}` };
    }

    const extracted = extractImageResult(data, prompt, imageModel);
    if (extracted.error) {
      return { error: extracted.error, raw: data };
    }

    return packageImageToolResult(extracted, {
      model: imageModel,
      encoding: extracted.encoding,
      via: upstream.via,
    });
  } catch (e) {
    return { error: `Image generation error: ${e.message}` };
  }
}

/** Extract markdown image URLs from assistant text. */
function extractMarkdownImageUrls(content) {
  const urls = [];
  const re = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/gi;
  let match;
  while ((match = re.exec(content)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}

/** Remove markdown image syntax, leaving caption text. */
function stripMarkdownImages(content) {
  return content.replace(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = {
  TOOL_DEFINITION,
  executeGenerateImage,
  resolveImageUpstream,
  extractMarkdownImageUrls,
  stripMarkdownImages,
};
