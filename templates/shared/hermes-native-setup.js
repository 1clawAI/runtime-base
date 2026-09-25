#!/usr/bin/env node
/**
 * Provision the loopback auth token for the in-container Hermes adapter.
 *
 * The 1claw-hermes OpenAI-compatible SSE adapter (started by
 * hermes-agent-start.sh on 127.0.0.1:8778) authenticates the in-container
 * bridge (native-agent-server.js) with a bearer token. The adapter reads the
 * token from ONECLAW_HERMES_NATIVE_TOKEN (env only); the bridge reads it from
 * that env var OR — because the two run in *separate processes that do not
 * share an env* — from a 0600 file on disk (resolveHermesToken()). This script
 * is the writer of that file, mirroring the token half of
 * openclaw-runtime-setup.js.
 *
 * Persist once and reuse across restarts so the token is stable for the
 * lifetime of the container filesystem. Prints the token *path* (never the
 * value) to stderr.
 *
 * ONECLAW_HERMES_TOKEN_FILE overrides the path (must match the bridge's
 * resolveHermesToken() default, i.e. $HERMES_CONFIG_DIR/native-loopback-token).
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const home = process.env.HOME || os.homedir();
const hermesDir =
  process.env.HERMES_CONFIG_DIR ||
  process.env.HERMES_HOME ||
  path.join(home, ".hermes");

const tokenFile =
  process.env.ONECLAW_HERMES_TOKEN_FILE ||
  path.join(hermesDir, "native-loopback-token");

fs.mkdirSync(path.dirname(tokenFile), { recursive: true });

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

// Never print the token value — only where it lives, for operator visibility.
console.error(
  `[hermes-native] provisioned loopback adapter token at ${tokenFile} (0600)`
);
