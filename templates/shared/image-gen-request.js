"use strict";

/**
 * Model-aware OpenAI /v1/images/generations request builder.
 *
 * OpenAI retired dall-e-2 and dall-e-3 on 2026-05-12. Current models:
 * - gpt-image-2 (recommended default)
 * - gpt-image-1 / gpt-image-1-mini (legacy; sunset Oct–Dec 2026)
 *
 * GPT Image models return b64_json (no style or response_format params).
 * Legacy DALL-E models are auto-migrated to gpt-image-2 at resolve time.
 */

/** Recommended default for standard OpenAI billing keys (Aug 2026+). */
const DEFAULT_IMAGE_MODEL = "gpt-image-2";

const LEGACY_DALLE3_SIZES = ["1024x1024", "1024x1792", "1792x1024"];
const DALLE2_SIZES = ["256x256", "512x512", "1024x1024"];
const GPT_IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536", "auto"];
const VALID_STYLES = ["vivid", "natural"];

/** @deprecated Use GPT_IMAGE_SIZES — kept for tool enum backward compatibility. */
const DALLE3_SIZES = LEGACY_DALLE3_SIZES;

const DEPRECATED_DALLE_MODELS = new Set(["dall-e-2", "dall-e-3"]);

function resolveImageModel(env, defaultModel) {
  const raw = String(
    env?.ONECLAW_IMAGE_MODEL || defaultModel || DEFAULT_IMAGE_MODEL
  ).trim();
  if (!raw) return DEFAULT_IMAGE_MODEL;
  if (DEPRECATED_DALLE_MODELS.has(raw.toLowerCase())) {
    return DEFAULT_IMAGE_MODEL;
  }
  return raw;
}

function isGptImageModel(model) {
  return String(model || "").startsWith("gpt-image");
}

function isDalle3Model(model) {
  return String(model || "") === "dall-e-3";
}

function isDalle2Model(model) {
  return String(model || "") === "dall-e-2";
}

function isDeprecatedDalleModel(model) {
  return DEPRECATED_DALLE_MODELS.has(String(model || "").toLowerCase());
}

/** Map legacy DALL-E aspect ratios to GPT Image equivalents. */
function normalizeImageSize(model, size) {
  const requested = String(size || "").trim() || "1024x1024";

  if (isGptImageModel(model)) {
    const legacyMap = {
      "1024x1792": "1024x1536",
      "1792x1024": "1536x1024",
    };
    const mapped = legacyMap[requested] || requested;
    if (GPT_IMAGE_SIZES.includes(mapped)) return mapped;
    if (mapped === "1024x1024") return "1024x1024";
    return "1024x1024";
  }

  if (isDalle2Model(model)) {
    return DALLE2_SIZES.includes(requested) ? requested : "1024x1024";
  }

  // dall-e-3 (legacy — should not reach here after resolveImageModel migration)
  return LEGACY_DALLE3_SIZES.includes(requested) ? requested : "1024x1024";
}

function buildImageGenerationBody({ model, prompt, size, style, quality }) {
  const body = { model, prompt, n: 1 };

  if (isGptImageModel(model)) {
    body.size = normalizeImageSize(model, size);
    const q = String(quality || "").trim().toLowerCase();
    if (["low", "medium", "high", "auto"].includes(q)) {
      body.quality = q;
    }
    return body;
  }

  if (isDalle2Model(model)) {
    body.size = normalizeImageSize(model, size);
    body.response_format = "url";
    return body;
  }

  // dall-e-3 (legacy)
  body.size = normalizeImageSize(model, size);
  if (style && VALID_STYLES.includes(style)) {
    body.style = style;
  } else {
    body.style = "vivid";
  }
  body.response_format = "url";
  return body;
}

/** Strip dall-e-3-only fields for a retry after unknown-parameter errors. */
function stripDalle3OnlyFields(body) {
  const next = { ...body };
  delete next.style;
  delete next.response_format;
  return next;
}

function isUnsupportedStyleError(detail) {
  const d = String(detail || "").toLowerCase();
  return d.includes("unknown parameter") && d.includes("style");
}

function isUnsupportedResponseFormatError(detail) {
  const d = String(detail || "").toLowerCase();
  return d.includes("unknown parameter") && d.includes("response_format");
}

function isModelNotFoundError(detail) {
  const d = String(detail || "").toLowerCase();
  return (
    d.includes("does not exist") ||
    d.includes("model_not_found") ||
    d.includes("invalid model") ||
    d.includes("model is not supported") ||
    d.includes("has been deprecated") ||
    d.includes("has been retired")
  );
}

function extractImageResult(data, prompt, model) {
  const item = data?.data?.[0];
  if (!item) {
    return { error: "Image API returned no data in the response" };
  }

  if (item.url) {
    return {
      url: item.url,
      revised_prompt: item.revised_prompt || prompt,
      model,
    };
  }

  if (item.b64_json) {
    return {
      url: `data:image/png;base64,${item.b64_json}`,
      revised_prompt: item.revised_prompt || prompt,
      model,
      encoding: "base64",
    };
  }

  return { error: "Image API returned no URL or image data" };
}

function formatModelNotFoundHint(model) {
  if (isDeprecatedDalleModel(model)) {
    return (
      `The image model "${model}" was retired by OpenAI in May 2026. ` +
      `Remove ONECLAW_IMAGE_MODEL or set ONECLAW_IMAGE_MODEL=${DEFAULT_IMAGE_MODEL}. ` +
      "Rebuild/restart the runtime to pick up the new default."
    );
  }
  return (
    `The image model "${model}" is not available on your OpenAI account. ` +
    `Set ONECLAW_IMAGE_MODEL=${DEFAULT_IMAGE_MODEL} (or gpt-image-1-mini) on the runtime, ` +
    "then restart."
  );
}

module.exports = {
  DEFAULT_IMAGE_MODEL,
  DALLE3_SIZES,
  LEGACY_DALLE3_SIZES,
  GPT_IMAGE_SIZES,
  VALID_STYLES,
  resolveImageModel,
  normalizeImageSize,
  buildImageGenerationBody,
  stripDalle3OnlyFields,
  isUnsupportedStyleError,
  isUnsupportedResponseFormatError,
  isModelNotFoundError,
  isDeprecatedDalleModel,
  extractImageResult,
  formatModelNotFoundHint,
  isGptImageModel,
  isDalle3Model,
};
