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

/**
 * A one-phrase description of what a tool returned, safe to show in the
 * browser.
 *
 * Tool *results* have never reached the UI — only the name, the redacted
 * arguments and whether it failed. So the transcript can say the agent
 * called `list_secrets`, but not that it came back with three. When the
 * agent then says "you have three secrets", there is nothing to check it
 * against, and an agent you cannot check is one you have to trust
 * completely.
 *
 * Results cannot be echoed: `get_secret` returns the secret. So this derives
 * only *shape* — counts, field tallies, a bare "ok" — and never reproduces
 * a value. Every branch returns a number or a fixed word; none interpolates
 * result content. That invariant is the whole point of this function, and
 * the tests below hold it against secret-shaped inputs.
 */
function summarizeToolResult(result) {
  if (result === null || result === undefined) return undefined;

  const plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

  if (Array.isArray(result)) return plural(result.length, "item");

  if (typeof result !== "object") {
    // A bare scalar could itself be the secret. Describe it, never show it.
    if (typeof result === "string") return plural(result.length, "char");
    if (typeof result === "boolean") return result ? "ok" : "false";
    return typeof result;
  }

  // The usual container shapes, in the order tools tend to use them.
  for (const key of ["items", "results", "secrets", "keys", "automations", "messages", "data"]) {
    if (Array.isArray(result[key])) return plural(result[key].length, "item");
  }
  if (typeof result.count === "number") return plural(result.count, "item");
  if (result.ok === true || result.success === true) return "ok";

  const fields = Object.keys(result).length;
  return fields ? plural(fields, "field") : "empty";
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
  summarizeToolResult,
  sanitizeMessagesForLlm,
  sanitizeMessageForLlm,
  isPromptTooLongError,
};
