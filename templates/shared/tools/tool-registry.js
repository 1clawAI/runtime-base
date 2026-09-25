#!/usr/bin/env node
/**
 * 1Claw Runtime Tool Registry
 *
 * Discovers available tools based on agent config (env vars, feature flags)
 * and returns OpenAI-format function definitions for each.
 *
 * Each tool module exports:
 *   - definition (or definitions[]) — OpenAI tool schema(s)
 *   - execute(args, context) — handler
 *   - isAvailable(env) — feature check
 */
"use strict";

function tryRequire(path) {
  try { return require(path); } catch { return null; }
}

const imageGen = require("./image-gen.js");
const webSearch = tryRequire("./web-search.js");
const memoryTools = tryRequire("./memory-tools.js");
const fileHandler = tryRequire("./file-handler.js");
const codeExec = tryRequire("./code-exec.js");
const googleTools = require("./google-tools.js");
const githubTools = require("./github-tools.js");
const slackTools = require("./slack-tools.js");
const socialTools = require("./social-tools.js");
const subAgents = require("./sub-agents.js");
const notifyTools = require("./notify-tools.js");
const vaultTools = require("./vault-tools.js");
const agentAccessTools = require("./agent-access-tools.js");
const signingTools = require("./signing-tools.js");

const ALL_TOOL_MODULES = [
  imageGen,
  webSearch,
  memoryTools,
  fileHandler,
  codeExec,
  googleTools,
  githubTools,
  slackTools,
  socialTools,
  subAgents,
  notifyTools,
  vaultTools,
  agentAccessTools,
  signingTools,
].filter(Boolean);

/**
 * Build a context object passed to tool execute() calls.
 * @param {object} [overrides]
 */
function buildContext(overrides = {}) {
  return {
    agentToken: null,
    vaultId: process.env.ONECLAW_VAULT_ID || "",
    agentId: process.env.ONECLAW_AGENT_ID || "",
    baseUrl:
      process.env.ONECLAW_VAULT_INTERNAL_URL ||
      process.env.ONECLAW_BASE_URL ||
      process.env.ONECLAW_API_URL ||
      "https://api.1claw.co",
    sidecarUrl: "http://127.0.0.1:8082",
    env: process.env,
    ...overrides,
  };
}

/**
 * Resolve which tools are available given environment and optional config overrides.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {object} [toolsConfig] - Per-template overrides from tools-config.js.
 *   Keys are tool names; values:
 *     - false: force-disable regardless of isAvailable()
 *     - true or "auto": enable only if isAvailable() returns true
 *     - "force": force-enable even if isAvailable() returns false (use sparingly)
 * @returns {{ definitions: object[], modules: Map<string, object> }}
 */
function getAvailableTools(env, toolsConfig = {}) {
  const definitions = [];
  const modules = new Map();

  for (const mod of ALL_TOOL_MODULES) {
    const defs = mod.definitions || (mod.definition ? [mod.definition] : []);
    for (const def of defs) {
      const name = def?.function?.name;
      if (!name) continue;

      const configOverride = toolsConfig[name];
      if (configOverride === false) continue;

      if (modules.has(name)) continue;

      // "force" bypasses isAvailable() — only use for tools with no env dependency.
      // true and "auto" both defer to isAvailable() so agent flags are respected.
      const available = configOverride === "force" || mod.isAvailable(env);
      if (available) {
        definitions.push(def);
        modules.set(name, mod);
      }
    }
  }

  return { definitions, modules };
}

/**
 * Merge multiple OpenAI tool definition arrays, keeping the first occurrence of each name.
 * Anthropic rejects duplicate tool names with HTTP 400; OpenAI silently ignores dupes.
 *
 * @param {...object[]} definitionLists
 * @returns {object[]}
 */
function mergeToolDefinitions(...definitionLists) {
  const definitions = [];
  const seen = new Set();
  for (const list of definitionLists) {
    if (!Array.isArray(list)) continue;
    for (const def of list) {
      const name = def?.function?.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      definitions.push(def);
    }
  }
  return definitions;
}

/**
 * Return duplicate tool names present in a definition list (empty when unique).
 *
 * @param {object[]} definitions
 * @returns {string[]}
 */
function findDuplicateToolNames(definitions) {
  const seen = new Set();
  const dupes = [];
  for (const def of definitions || []) {
    const name = def?.function?.name;
    if (!name) continue;
    if (seen.has(name)) dupes.push(name);
    seen.add(name);
  }
  return dupes;
}

/**
 * Execute a tool call by name.
 *
 * @param {string} name
 * @param {object} args
 * @param {object} context
 * @param {Map<string, object>} modules - from getAvailableTools()
 * @returns {Promise<object>}
 */
async function executeTool(name, args, context, modules) {
  const mod = modules.get(name);
  if (!mod) {
    return { error: `Unknown tool: ${name}` };
  }
  try {
    return await mod.execute(name, args, context);
  } catch (e) {
    return { error: `Tool "${name}" failed: ${e.message}` };
  }
}

/**
 * Return a human-readable summary of available tools for system prompts.
 * @param {Map<string, object>} modules
 * @returns {string}
 */
function describeAvailableTools(modules) {
  if (modules.size === 0) return "No additional tools are available.";
  const hints = {
    request_approval: "human approval for bindings/policies",
    list_channels: "discover connected messaging channels",
    list_bindings: "discover execution bindings",
    list_signing_keys: "get ETH/XRP/etc. wallet addresses (not in vault list)",
    get_signing_key_balance: "native/token balance for a signing key chain",
    remember: "persist facts across sessions",
    forget: "remove outdated memory entries",
  };
  const lines = [...modules.keys()].map((name) => {
    const hint = hints[name];
    return hint ? `- ${name}: ${hint}` : `- ${name}`;
  });
  return `Additional tools:\n${lines.join("\n")}`;
}

module.exports = {
  getAvailableTools,
  mergeToolDefinitions,
  findDuplicateToolNames,
  executeTool,
  buildContext,
  describeAvailableTools,
  ALL_TOOL_MODULES,
};
