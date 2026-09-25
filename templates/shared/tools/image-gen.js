#!/usr/bin/env node
/**
 * Image Generation Tool (DALL-E)
 *
 * Refactored from shared/image-gen.js into the tool registry pattern.
 * Routes through Shroud sidecar or direct provider API.
 */
"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { apiAuthHeaders } = require("../agent-token.js");
const {
  DEFAULT_IMAGE_MODEL,
  GPT_IMAGE_SIZES,
  LEGACY_DALLE3_SIZES,
  VALID_STYLES,
  resolveImageModel,
  buildImageGenerationBody,
  stripDalle3OnlyFields,
  isUnsupportedStyleError,
  isUnsupportedResponseFormatError,
  isModelNotFoundError,
  formatModelNotFoundHint,
  extractImageResult,
} = require("../image-gen-request.js");
const { packageImageToolResult } = require("../generated-image-cache.js");

const VALID_SIZES = GPT_IMAGE_SIZES.concat(LEGACY_DALLE3_SIZES, [
  "256x256",
  "512x512",
]);

/** Standard vault paths for BYOK OpenAI keys (first match wins). */
const OPENAI_KEY_PATHS = [
  process.env.ONECLAW_OPENAI_KEY_PATH,
  "providers/openai/api-key",
  "api-keys/openai",
].filter(Boolean);

const BYOK_IMAGE_GEN_HINT =
  "To enable GPT Image generation:\n" +
  "1. Dashboard → Runtimes → (your runtime) → Config → API Keys — save an OpenAI key at providers/openai/api-key, then Stop and Start the runtime (refreshes the agent token after the first save).\n" +
  "2. Dashboard → Agents → (your agent) → enable Shroud LLM Proxy.\n" +
  "Stripe LLM billing covers chat only — image generation always requires a real OpenAI API key. " +
  "Do not use Runtime → Environment for API keys; that tab blocks *API_KEY* names for security.";

/** In-process cache: path → { key, expiresAt } */
const vaultKeyCache = new Map();
const VAULT_KEY_CACHE_MS = 5 * 60 * 1000;

async function fetchVaultSecret(context, path) {
  const cacheKey = `${context.vaultId}:${path}`;
  const cached = vaultKeyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { key: cached.key };
  }

  const { agentToken, vaultId, baseUrl } = context;
  if (!agentToken) {
    return { key: null, error: "no agent token for vault read" };
  }
  if (!vaultId) {
    return { key: null, error: "ONECLAW_VAULT_ID is not set on the runtime" };
  }

  const url = `${baseUrl}/v1/vaults/${vaultId}/secrets/${encodeURIComponent(path)}`;
  const resp = await httpPostJson(url, apiAuthHeaders(agentToken), null, 15000);
  if (resp.status !== 200) {
    const detail =
      (() => {
        try {
          const parsed = JSON.parse(resp.text);
          return parsed?.detail || parsed?.error?.message;
        } catch {
          return resp.text.slice(0, 120);
        }
      })() || `HTTP ${resp.status}`;
    return { key: null, error: `${path}: ${detail}` };
  }

  let data;
  try {
    data = JSON.parse(resp.text);
  } catch {
    return { key: null, error: `${path}: invalid vault response` };
  }
  const key = (data?.value || "").trim();
  if (!key) {
    return { key: null, error: `${path}: secret exists but value is empty` };
  }

  vaultKeyCache.set(cacheKey, { key, expiresAt: Date.now() + VAULT_KEY_CACHE_MS });
  return { key };
}

async function resolveOpenAiKeyFromVault(context) {
  const errors = [];
  const vaultIds = [
    ...(process.env.ONECLAW_VAULT_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    context.vaultId,
  ].filter((id, idx, arr) => id && arr.indexOf(id) === idx);

  for (const vaultId of vaultIds) {
    const ctx = { ...context, vaultId };
    for (const path of OPENAI_KEY_PATHS) {
      const result = await fetchVaultSecret(ctx, path);
      if (result.key) {
        return { key: result.key, errors };
      }
      if (result.error) errors.push(`[${vaultId}] ${result.error}`);
    }
  }
  return { key: null, errors };
}

const definition = {
  type: "function",
  function: {
    name: "generate_image",
    description:
      "Generate an image from a text prompt using OpenAI GPT Image (default gpt-image-2). " +
      "Returns a URL or inline base64 data URI. " +
      "Use when the user asks for a picture, illustration, meme, or visual.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Detailed description of the image to generate",
        },
        size: {
          type: "string",
          enum: VALID_SIZES,
          description: "Image dimensions (default 1024x1024)",
        },
        style: {
          type: "string",
          enum: VALID_STYLES,
          description: "Image style: vivid (dramatic/hyper-real) or natural (more subdued)",
        },
      },
      required: ["prompt"],
    },
  },
};

function isAvailable() {
  // Always available on every tier — like Web Search. Image generation does
  // NOT require the Business+ Shroud LLM *chat* proxy (ONECLAW_SHROUD_ENABLED):
  // when no BYOK key and no shroud routing are configured, resolveImageUpstream
  // falls back to Shroud's public `/v1/images/generations`, which is served by
  // the platform OpenAI key and is not billed through the Stripe LLM gateway.
  // A BYOK key or shroud routing just changes *how* it generates, not *whether*
  // it can. Auth/quota failures surface as a graceful error, not an outage.
  return true;
}

function resolveImageUpstream(env, context) {
  if (
    env.ONECLAW_SHROUD_ENABLED === "1" ||
    env.ONECLAW_SHROUD_ENABLED === "true"
  ) {
    return {
      url: `${context.sidecarUrl}/v1/images/generations`,
      via: "sidecar",
    };
  }
  const openaiBase = (env.OPENAI_BASE_URL || "").replace(/\/$/, "");
  if (openaiBase) {
    const path = openaiBase.endsWith("/v1")
      ? `${openaiBase}/images/generations`
      : `${openaiBase}/v1/images/generations`;
    return { url: path, via: "openai_base_url" };
  }
  if (env.OPENAI_API_KEY) {
    return {
      url: "https://api.openai.com/v1/images/generations",
      via: "direct-openai",
    };
  }
  const shroud = (
    env.ONECLAW_SHROUD_URL || "https://shroud.1claw.co"
  ).replace(/\/$/, "");
  return { url: `${shroud}/v1/images/generations`, via: "shroud" };
}

function httpPostJson(url, headers, body, timeoutMs = 120000) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  const payload = body != null ? JSON.stringify(body) : null;
  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === "https:" ? 443 : 80),
    path: u.pathname + u.search,
    method: body != null ? "POST" : "GET",
    headers: {
      Accept: "application/json",
      ...headers,
    },
    timeout: timeoutMs,
  };
  if (payload != null) {
    opts.headers["Content-Type"] = "application/json";
    opts.headers["Content-Length"] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (resp) => {
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () => {
        resolve({ status: resp.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Image generation request timed out (120s)"));
    });
    if (payload != null) req.write(payload);
    req.end();
  });
}

function buildImageAuthHeaders(env, context, resolvedVaultKey) {
  const headers = {};
  const directKey = resolvedVaultKey || env.OPENAI_API_KEY;
  if (directKey && !context._shroudRouted) {
    headers.Authorization = `Bearer ${directKey}`;
    return headers;
  }

  if (context.agentToken) {
    headers.Authorization = `Bearer ${context.agentToken}`;
    headers["X-Shroud-Provider"] = "openai";
    // BYOK through Shroud/sidecar: pass vault key alongside agent JWT.
    if (resolvedVaultKey) {
      headers["X-Shroud-Api-Key"] = resolvedVaultKey;
    }
    const apiKey = env.ONECLAW_AGENT_API_KEY || "";
    const agentId = context.agentId;
    if (agentId && apiKey && !apiKey.startsWith("eyJ")) {
      headers["X-Shroud-Agent-Key"] = `${agentId}:${apiKey}`;
    }
  }
  return headers;
}

function formatImageGenFailure(resp, data, upstream, vaultKeyErrors) {
  const detail =
    data?.error?.message ||
    data?.detail ||
    data?.message ||
    (typeof resp.text === "string" ? resp.text.slice(0, 300) : "unknown error");

  if (resp.status === 400 && isModelNotFoundError(detail)) {
    const attempted = data?.model || process.env.ONECLAW_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
    return formatModelNotFoundHint(attempted);
  }

  if (resp.status === 400 && isUnsupportedStyleError(detail)) {
    return (
      `Image model does not support the 'style' parameter (${detail}). ` +
      "GPT Image models ignore style — remove the style argument or set ONECLAW_IMAGE_MODEL=gpt-image-2."
    );
  }

  if (resp.status === 401) {
    const vaultHint =
      vaultKeyErrors.length > 0 ? ` Vault read errors: ${vaultKeyErrors.join("; ")}.` : "";
    const openAiRejected =
      detail &&
      !/runtime-bound token|insufficient permissions|access denied/i.test(detail);
    if (openAiRejected && vaultKeyErrors.length === 0) {
      return (
        `OpenAI rejected the API key (${detail}). ` +
        "Re-save a valid key at Dashboard → Runtimes → Config → API Keys, then Stop and Start the runtime."
      );
    }
    return `Image generation authentication failed.${vaultHint} ${BYOK_IMAGE_GEN_HINT}`;
  }

  return `Image generation failed (${resp.status}, ${upstream.via}): ${detail}`;
}

/**
 * @param {string} _name - tool name (generate_image)
 * @param {object} args
 * @param {object} context
 */
async function execute(_name, args, context) {
  let agentToken = context.agentToken;
  try {
    const { getAgentToken } = require("../agent-token.js");
    agentToken = getAgentToken() || agentToken;
  } catch {
    /* agent-token optional outside runtime */
  }
  const execContext = { ...context, agentToken };

  const prompt = (args.prompt || "").trim();
  if (!prompt) return { error: "prompt is required" };

  const size =
    args.size && VALID_SIZES.includes(args.size)
      ? args.size
      : "1024x1024";
  const style =
    args.style && VALID_STYLES.includes(args.style)
      ? args.style
      : undefined;

  const env = execContext.env || process.env;
  let imageModel = resolveImageModel(env, DEFAULT_IMAGE_MODEL);
  const upstream = resolveImageUpstream(env, execContext);
  execContext._shroudRouted = upstream.via === "sidecar" || upstream.via === "shroud";

  let vaultKey = null;
  let vaultKeyErrors = [];
  if (!env.OPENAI_API_KEY) {
    const resolved = await resolveOpenAiKeyFromVault(execContext);
    vaultKey = resolved.key;
    vaultKeyErrors = resolved.errors;
    if (!vaultKey && upstream.via === "direct-openai") {
      const vaultHint =
        vaultKeyErrors.length > 0 ? ` ${vaultKeyErrors.join("; ")}.` : "";
      return { error: `${BYOK_IMAGE_GEN_HINT}${vaultHint}` };
    }
  }

  const imageQuality = env.ONECLAW_IMAGE_QUALITY;
  let body = buildImageGenerationBody({
    model: imageModel,
    prompt,
    size,
    style,
    quality: imageQuality,
  });

  const headers = buildImageAuthHeaders(env, execContext, vaultKey);
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await httpPostJson(upstream.url, headers, body);

      let data;
      try {
        data = JSON.parse(resp.text);
      } catch {
        if (attempt < maxAttempts && resp.status >= 500) continue;
        return {
          error: `Invalid response from image API (${upstream.via}): ${resp.text.slice(0, 200)}`,
        };
      }

      if (resp.status >= 500 && attempt < maxAttempts) continue;

      if (resp.status >= 400) {
        if (resp.status === 400) {
          const detail =
            data?.error?.message ||
            data?.detail ||
            data?.message ||
            resp.text.slice(0, 300);
          if (detail.includes("content_policy")) {
            return {
              error:
                "Image generation was blocked by the content policy. " +
                "Try rephrasing your prompt to avoid restricted content.",
            };
          }
        }
        if (resp.status === 429) {
          return {
            error:
              "Image generation rate limited. Please wait a moment and try again.",
          };
        }
        const detail =
          data?.error?.message ||
          data?.detail ||
          data?.message ||
          resp.text.slice(0, 300);
        if (
          resp.status === 400 &&
          attempt < maxAttempts &&
          (isUnsupportedStyleError(detail) ||
            isUnsupportedResponseFormatError(detail))
        ) {
          body = stripDalle3OnlyFields(body);
          continue;
        }
        if (resp.status === 400 && attempt < maxAttempts && isModelNotFoundError(detail)) {
          imageModel = DEFAULT_IMAGE_MODEL;
          body = buildImageGenerationBody({
            model: imageModel,
            prompt,
            size,
            quality: imageQuality,
          });
          continue;
        }
        return {
          error: formatImageGenFailure(resp, data, upstream, vaultKeyErrors),
        };
      }

      const extracted = extractImageResult(data, prompt, imageModel);
      if (extracted.error) {
        return { error: extracted.error };
      }

      return packageImageToolResult(extracted, {
        model: imageModel,
        size,
        style: body.style,
        via: upstream.via,
      });
    } catch (e) {
      if (attempt < maxAttempts) continue;
      return { error: `Image generation error: ${e.message}` };
    }
  }

  return { error: "Image generation failed after retries" };
}

module.exports = {
  definition,
  definitions: [definition],
  isAvailable,
  execute,
};
