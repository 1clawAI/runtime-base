"use strict";

/**
 * Shared agent JWT helpers for runtime chat bridges.
 * Vault sends a fresh JWT on each dashboard chat via X-Refreshed-Agent-Token.
 */

let refreshedAgentToken = null;
let refreshedAgentTokenExpMs = null;

function looksLikeJwt(token) {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  return parts.length === 3 && parts[0] && parts[1] && parts[2];
}

function parseJwtExpMs(token) {
  if (!looksLikeJwt(token)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8")
    );
    if (typeof payload.exp === "number" && payload.exp > 0) {
      return payload.exp * 1000;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function acceptRefreshedAgentToken(raw) {
  if (!raw || typeof raw !== "string" || !looksLikeJwt(raw)) return false;
  refreshedAgentToken = raw;
  refreshedAgentTokenExpMs = parseJwtExpMs(raw);
  return true;
}

function getAgentToken() {
  const token =
    refreshedAgentToken ||
    process.env.ONECLAW_AGENT_TOKEN ||
    process.env.ONECLAW_TOKEN ||
    process.env.ONECLAW_AGENT_API_KEY ||
    "";
  if (!token) return "";

  const expMs =
    token === refreshedAgentToken
      ? refreshedAgentTokenExpMs
      : parseJwtExpMs(token);
  if (expMs && Date.now() >= expMs - 60_000) {
    // Prefer env token only when refreshed token is missing/expiring.
    if (token === refreshedAgentToken) {
      const envToken =
        process.env.ONECLAW_AGENT_TOKEN || process.env.ONECLAW_TOKEN || "";
      if (envToken && envToken !== token) {
        const envExp = parseJwtExpMs(envToken);
        if (!envExp || Date.now() < envExp - 60_000) return envToken;
      }
    }
  }
  return token;
}

/** Bearer + runtime binding headers for Vault API calls from cloud runtimes. */
function apiAuthHeaders(token) {
  const bearer = token || getAgentToken();
  const headers = {};
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const runtimeId = process.env.ONECLAW_RUNTIME_ID;
  if (runtimeId) headers["X-1Claw-Runtime-Id"] = runtimeId;
  return headers;
}

function isExpiredSignatureError(status, bodyText) {
  if (status !== 401) return false;
  const lower = (bodyText || "").toLowerCase();
  return lower.includes("expiredsignature") || lower.includes("jwt validation failed");
}

module.exports = {
  acceptRefreshedAgentToken,
  apiAuthHeaders,
  getAgentToken,
  isExpiredSignatureError,
  looksLikeJwt,
};
