"use strict";

/**
 * Ephemeral in-memory cache for generated images.
 * GPT Image returns b64_json; we register the data URI here and pass a short
 * 1claw-image:// ref to the LLM so tool results do not blow up context size.
 */

const crypto = require("crypto");

let sanitizeToolResultContent = (value) => JSON.stringify(value ?? {});
try {
  ({ sanitizeToolResultContent } = require("./message-sanitize.js"));
} catch {
  /* optional in isolated tests */
}

const cache = new Map();
const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 20;

function registerGeneratedImage(dataUri) {
  const ref = crypto.randomUUID();
  cache.set(ref, { dataUri, expiresAt: Date.now() + TTL_MS });
  prune();
  return ref;
}

function getGeneratedImage(ref) {
  const entry = cache.get(ref);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(ref);
    return null;
  }
  return entry.dataUri;
}

function resolveImageRefs(text) {
  if (typeof text !== "string" || !text) return text;
  return text.replace(
    /!\[([^\]]*)\]\(1claw-image:\/\/([0-9a-f-]{36})\)/gi,
    (match, alt, ref) => {
      const uri = getGeneratedImage(ref);
      return uri ? `![${alt}](${uri})` : match;
    }
  ).replace(/1claw-image:\/\/([0-9a-f-]{36})/gi, (match, ref) => {
    return getGeneratedImage(ref) || match;
  });
}

function parseToolMessageData(msg) {
  if (!msg || msg.role !== "tool") return null;
  try {
    return typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content;
  } catch {
    return null;
  }
}

function isImageToolResult(data) {
  if (!data || typeof data !== "object") return false;
  if (typeof data.error === "string" && /image generation/i.test(data.error)) {
    return true;
  }
  return Boolean(
    data.image_ref ||
      (typeof data.url === "string" &&
        (data.url.startsWith("1claw-image://") ||
          data.url.startsWith("data:image/") ||
          data.url.startsWith("http")))
  );
}

/** True when the user is asking for a generated picture/drawing/etc. */
function looksLikeImageRequest(text) {
  if (typeof text !== "string") return false;
  const lower = text.toLowerCase();
  if (/\b(dall-?e|gpt-?image|image gen(?:eration)?|picture of|photo of|illustration of)\b/.test(lower)) {
    return true;
  }
  if (
    /\b(draw|paint|sketch|design|render|illustrate)\b/.test(lower) &&
    !/\b(diagram|chart|graph|plot|flowchart|architecture|wireframe)\b/.test(lower)
  ) {
    return true;
  }
  return (
    /\b(generate|create|make|draw|paint|design|render|produce)\b/.test(lower) &&
    /\b(image|picture|photo|illustration|artwork|drawing|visual|meme|logo|icon|avatar|wallpaper)\b/.test(
      lower
    )
  );
}

/** True when the assistant turn already invoked generate_image via tool_calls. */
function hadGenerateImageToolCall(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some(
    (msg) =>
      msg &&
      msg.role === "assistant" &&
      Array.isArray(msg.tool_calls) &&
      msg.tool_calls.some((tc) => tc?.function?.name === "generate_image")
  );
}

/** Best-effort prompt extraction from a natural-language image request. */
function extractImagePromptFromRequest(text) {
  if (typeof text !== "string") return "Generated image";
  let prompt = text.trim();
  prompt = prompt.replace(/^(please\s+)?(can you\s+)?/i, "");
  prompt = prompt.replace(
    /^(generate|create|make|draw|paint|design|render|produce)\s+(me\s+)?(an?\s+)?(image|picture|photo|illustration|drawing|visual)\s+(of\s+)?/i,
    ""
  );
  prompt = prompt.replace(/\?+$/, "").trim();
  return prompt || text.trim() || "Generated image";
}

function hadImageGenerationAttempt(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((msg) => isImageToolResult(parseToolMessageData(msg)));
}

/** Collect generate_image tool error strings from the current turn. */
function collectImageErrorsFromMessages(messages) {
  const errors = [];
  if (!Array.isArray(messages)) return errors;

  for (const msg of messages) {
    const data = parseToolMessageData(msg);
    if (!data || typeof data.error !== "string" || !data.error.trim()) continue;
    if (
      !isImageToolResult(data) &&
      !data.image_ref &&
      !data.url &&
      !data.via &&
      !data.model
    ) {
      continue;
    }
    errors.push(data.error.trim());
  }

  return errors;
}

/** Parse generate_image tool JSON results for embeddable image refs/URLs. */
function collectImageRefsFromMessages(messages) {
  const refs = [];
  if (!Array.isArray(messages)) return refs;

  for (const msg of messages) {
    const data = parseToolMessageData(msg);
    if (!data || data.error) continue;

    const alt =
      (typeof data.revised_prompt === "string" && data.revised_prompt.trim()) ||
      (typeof data.prompt === "string" && data.prompt.trim()) ||
      "Generated image";

    if (typeof data.image_ref === "string" && data.image_ref) {
      refs.push({ ref: data.image_ref, alt });
      continue;
    }
    if (typeof data.url === "string" && data.url.startsWith("1claw-image://")) {
      refs.push({ ref: data.url.slice("1claw-image://".length), alt });
      continue;
    }
    if (
      typeof data.url === "string" &&
      (data.url.startsWith("data:image/") || data.url.startsWith("http"))
    ) {
      refs.push({ directUrl: data.url, alt });
    }
  }

  return refs;
}

function contentShowsImageRef(content, ref) {
  if (typeof content !== "string" || !ref) return false;
  if (content.includes(`1claw-image://${ref}`)) return true;
  const uri = getGeneratedImage(ref);
  if (uri && content.includes(uri.slice(0, 80))) return true;
  return false;
}

/**
 * Ensure assistant replies include markdown for images produced this turn.
 * LLMs often celebrate success without embedding ![...](url).
 */
function finalizeAssistantContent(content, conversationMessages) {
  let out = typeof content === "string" ? content : "";
  const refs = collectImageRefsFromMessages(conversationMessages);
  for (const item of refs) {
    const safeAlt =
      String(item.alt).replace(/[\[\]()]/g, " ").trim() || "Generated image";
    if (item.directUrl) {
      if (out.includes(item.directUrl)) continue;
      out += `${out.trim() ? "\n\n" : ""}![${safeAlt}](${item.directUrl})`;
      continue;
    }
    if (contentShowsImageRef(out, item.ref)) continue;
    out += `${out.trim() ? "\n\n" : ""}![${safeAlt}](1claw-image://${item.ref})`;
  }

  const errors = collectImageErrorsFromMessages(conversationMessages);
  if (errors.length > 0 && refs.length === 0) {
    const err = errors[errors.length - 1];
    const lower = out.toLowerCase();
    const claimsSuccess =
      /\b(here('s| is)|i('ve| have) generated|your (image|picture|lobster|photo)|enjoy)\b/.test(
        lower
      ) && !lower.includes("failed");
    if (claimsSuccess || !out.trim()) {
      out = `**Image generation failed**\n\n${err}${out.trim() ? `\n\n---\n\n${out}` : ""}`;
    } else if (!lower.includes("image generation failed")) {
      out += `${out.trim() ? "\n\n" : ""}**Image generation failed:** ${err}`;
    }
  }

  return resolveImageRefs(out);
}

/**
 * When the user asked for an image but the LLM skipped generate_image, call it
 * directly so finalizeAssistantContent can embed the result.
 */
async function supplementMissingImageGeneration(
  conversationMessages,
  executeToolFn,
  { enabled = true } = {}
) {
  if (!enabled || typeof executeToolFn !== "function") {
    return conversationMessages;
  }
  if (!Array.isArray(conversationMessages)) return conversationMessages;

  const lastUser = [...conversationMessages]
    .reverse()
    .find((m) => m && m.role === "user");
  const userText =
    typeof lastUser?.content === "string" ? lastUser.content.trim() : "";
  if (!looksLikeImageRequest(userText)) return conversationMessages;
  if (collectImageRefsFromMessages(conversationMessages).length > 0) {
    return conversationMessages;
  }
  if (hadGenerateImageToolCall(conversationMessages)) {
    return conversationMessages;
  }

  const prompt = extractImagePromptFromRequest(userText);
  const result = await executeToolFn("generate_image", { prompt });
  conversationMessages.push({
    role: "tool",
    tool_call_id: "auto-generate-image",
    content: sanitizeToolResultContent(result),
  });
  return conversationMessages;
}

function packageImageToolResult(extracted, meta = {}) {
  let url = extracted.url;
  let imageRef = null;
  if (
    extracted.encoding === "base64" &&
    typeof url === "string" &&
    url.startsWith("data:")
  ) {
    imageRef = registerGeneratedImage(url);
    url = `1claw-image://${imageRef}`;
  }
  return {
    url,
    ...(imageRef ? { image_ref: imageRef } : {}),
    revised_prompt: extracted.revised_prompt,
    ...meta,
    encoding: imageRef ? "ref" : extracted.encoding,
    ...(imageRef
      ? {
          hint:
            "Image ready. Include markdown ![description](url) using the url field above. " +
            "Do not request or paste raw image bytes.",
        }
      : {}),
  };
}

function prune() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt < now) cache.delete(key);
  }
  while (cache.size > MAX_ENTRIES) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

module.exports = {
  registerGeneratedImage,
  getGeneratedImage,
  resolveImageRefs,
  looksLikeImageRequest,
  extractImagePromptFromRequest,
  collectImageErrorsFromMessages,
  collectImageRefsFromMessages,
  hadImageGenerationAttempt,
  hadGenerateImageToolCall,
  finalizeAssistantContent,
  supplementMissingImageGeneration,
  packageImageToolResult,
};
