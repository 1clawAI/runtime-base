#!/usr/bin/env node
/**
 * Write ~/.openclaw/openclaw.json with @1claw/openclaw-plugin enabled.
 * Credentials come from ONECLAW_* env injected by Vault at runtime start.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const home = process.env.HOME || os.homedir();
const openclawDir = process.env.OPENCLAW_CONFIG_DIR || path.join(home, ".openclaw");
const configPath = path.join(openclawDir, "openclaw.json");

// Loopback auth token for the gateway's OpenAI-compatible HTTP endpoint. It's
// shared with the in-container 1Claw bridge (native-agent-server.js) via a file
// on disk — the two processes don't share an env. Persist once and reuse across
// restarts so the token is stable for the lifetime of the container filesystem.
// ONECLAW_OPENCLAW_TOKEN_FILE overrides the path (must match the bridge's).
const tokenFile =
  process.env.ONECLAW_OPENCLAW_TOKEN_FILE || path.join(openclawDir, "gateway-loopback-token");

fs.mkdirSync(openclawDir, { recursive: true });

let loopbackToken = "";
try {
  loopbackToken = fs.readFileSync(tokenFile, "utf8").trim();
} catch { /* not provisioned yet */ }
if (!loopbackToken) {
  loopbackToken = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(tokenFile, loopbackToken + "\n", { mode: 0o600 });
}
// Tighten perms even if the file pre-existed with a looser mode.
try { fs.chmodSync(tokenFile, 0o600); } catch { /* best effort */ }

const shroudEnabled =
  process.env.ONECLAW_SHROUD_ENABLED === "1" ||
  process.env.ONECLAW_SHROUD_ENABLED === "true" ||
  process.env.ENABLE_SHROUD === "true";

const enableMcp =
  process.env.ENABLE_MCP_TOOLS !== "false" &&
  process.env.ENABLE_MCP_TOOLS !== "0";

// When running as a 1Claw cloud runtime (ONECLAW_AGENT_ID set), platform
// slash_commands.rs handles slash commands. Disable native plugin commands
// to avoid duplicates. The env var OPENCLAW_SLASH_COMMANDS is set by entrypoint.sh.
const enableSlashCommands =
  process.env.OPENCLAW_SLASH_COMMANDS !== "0" &&
  process.env.OPENCLAW_SLASH_COMMANDS !== "false";

const features = {
  tools: enableMcp,
  secretInjection: false,
  secretRedaction: true,
  shroudRouting: shroudEnabled,
  keyRotationMonitor: false,
  slashCommands: enableSlashCommands,
};

const pluginConfig = {
  agentId: process.env.ONECLAW_AGENT_ID || undefined,
  vaultId: process.env.ONECLAW_VAULT_ID || undefined,
  baseUrl: process.env.ONECLAW_BASE_URL || process.env.ONECLAW_API_URL || "https://api.1claw.co",
  shroudUrl: process.env.ONECLAW_SHROUD_URL || "https://shroud.1claw.co",
  features,
};

let existing = {};
if (fs.existsSync(configPath)) {
  try {
    existing = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    existing = {};
  }
}

const existingGateway = existing.gateway || {};
const existingHttp = existingGateway.http || {};
const existingEndpoints = existingHttp.endpoints || {};

const merged = {
  ...existing,
  gateway: {
    mode: "local",
    bind: "loopback",
    ...existingGateway,
    // Enable the OpenAI-compatible HTTP endpoint so the 1Claw bridge can proxy
    // dashboard chat straight to the native OpenClaw agent loop. Loopback-only
    // (bind stays "loopback"); the token gates the in-container bridge call.
    http: {
      ...existingHttp,
      enabled: true,
      authToken: loopbackToken,
      endpoints: {
        ...existingEndpoints,
        chatCompletions: {
          ...(existingEndpoints.chatCompletions || {}),
          enabled: true,
        },
      },
    },
  },
  plugins: {
    ...(existing.plugins || {}),
    entries: {
      ...((existing.plugins && existing.plugins.entries) || {}),
      "1claw": {
        enabled: true,
        config: {
          ...(((existing.plugins || {}).entries || {})["1claw"] || {}).config,
          ...pluginConfig,
        },
      },
    },
  },
};

fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n");
console.error(
  `[openclaw-runtime] Wrote ${configPath} with @1claw/openclaw-plugin enabled ` +
  `(loopback OpenAI chatCompletions endpoint on; token at ${tokenFile})`
);
