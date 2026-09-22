/**
 * OpenClaw template — tools-config.js
 *
 * Values: true/"auto" = enable if isAvailable() passes (respects agent flags);
 *         "force" = enable unconditionally; false = always disable.
 *
 * Memory tools use "auto" so they respect ONECLAW_MEMORY_ENABLED. Setting them
 * to true previously caused silent 403 errors when the agent had memory_enabled=false.
 */
"use strict";

module.exports = {
  generate_image: true,
  web_search: true,
  remember: "auto",
  recall: "auto",
  forget: "auto",
  search_memory: "auto",
  analyze_image: true,
  read_url: true,
  execute_code: true,
  request_approval: "auto",
  check_approval_status: "auto",
  list_channels: "auto",
  list_bindings: "auto",
  list_signing_keys: "auto",
  get_signing_key_balance: "auto",
};
