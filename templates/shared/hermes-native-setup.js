#!/usr/bin/env node
/**
 * Provision the loopback auth token for Hermes' built-in API server.
 *
 * Hermes' own OpenAI-compatible API server (started by hermes-agent-start.sh on
 * 127.0.0.1:8642 as part of `hermes gateway`) authenticates callers with a
 * bearer token (API_SERVER_KEY). hermes-agent-start.sh reads the token this
 * script writes and exports it as API_SERVER_KEY; the 1Claw bridge
 * (native-agent-server.js) reads the same 0600 file (resolveHermesToken()) —
 * because the two run in *separate processes that do not share an env* — so
 * their bearers match. This script is the writer of that file, mirroring the
 * token half of openclaw-runtime-setup.js.
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
