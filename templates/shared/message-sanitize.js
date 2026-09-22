"use strict";

/**
 * Strip oversized payloads (inline images, base64 blobs) before LLM requests.
 */

const DATA_URI_PLACEHOLDER = "[inline image omitted from context]";
const MAX_TOOL_RESULT_CHARS = 16_000;
const MAX_MESSAGE_CHARS = 32_000;

function stripDataUris(text) {
  if (typeof text !== "string" || !text) return text;
  return text.replace(
    /data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=\s]+/g,
    DATA_URI_PLACEHOLDER
  );
}

function stripLongBase64(text) {
  if (typeof text !== "string" || !text) return text;
  return text.replace(/[A-Za-z0-9+/=]{500,}/g, "[base64 payload omitted from context]");
}

function sanitizeTextForLlm(text) {
  if (typeof text !== "string") return text;
  let out = stripDataUris(text);
  out = stripLongBase64(out);
  if (out.length > MAX_MESSAGE_CHARS) {
    out = `${out.slice(0, MAX_MESSAGE_CHARS)}\n...(truncated for LLM context)`;
  }
  return out;
}

function sanitizeToolResultValue(value) {
  if (value == null) return value;
  if (typeof value === "string") return sanitizeTextForLlm(value);
  if (Array.isArray(value)) return value.map(sanitizeToolResultValue);
  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (key === "image_data_uri" || key === "_display_url") continue;
      out[key] = sanitizeToolResultValue(val);
    }
    return out;
  }
  return value;
}

function sanitizeToolResultContent(result) {
  const sanitized = sanitizeToolResultValue(result);
  let json = JSON.stringify(sanitized);
  if (json.length > MAX_TOOL_RESULT_CHARS) {
    json = `${json.slice(0, MAX_TOOL_RESULT_CHARS)}...(truncated)`;
  }
  return json;
}

function sanitizeMessageForLlm(msg) {
  if (!msg || typeof msg !== "object") return msg;
  const out = { ...msg };

  if (typeof out.content === "string") {
    out.content = sanitizeTextForLlm(out.content);
  } else if (Array.isArray(out.content)) {
    out.content = out.content.map((part) => {
      if (!part || typeof part !== "object") return part;
      if (part.type === "image_url") {
        const url = part.image_url?.url || "";
        if (typeof url === "string" && url.startsWith("data:")) {
          return { type: "text", text: DATA_URI_PLACEHOLDER };
        }
      }
      if (typeof part.text === "string") {
        return { ...part, text: sanitizeTextForLlm(part.text) };
      }
      return part;
    });
  }

  return out;
}

function sanitizeMessagesForLlm(messages) {
  return messages.map(sanitizeMessageForLlm);
}

function isPromptTooLongError(message) {
  const msg = String(message || "").toLowerCase();
  return msg.includes("prompt is too long") || msg.includes("tokens >");
}

module.exports = {
  DATA_URI_PLACEHOLDER,
  sanitizeTextForLlm,
  sanitizeToolResultContent,
  sanitizeMessagesForLlm,
  sanitizeMessageForLlm,
  isPromptTooLongError,
};
