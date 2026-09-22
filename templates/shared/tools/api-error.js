"use strict";

/**
 * Parse Vault API error bodies and attach actionable guidance for common agent 403s.
 */

const HUMAN_ONLY_HINTS = [
  {
    match: /cannot create their own bindings/i,
    hint:
      "Binding creation requires a human operator. You CAN list_bindings and execute_intent on existing bindings. Use request_approval to ask your operator to create one.",
  },
  {
    match: /cannot (create|update|delete) (automations|bindings)/i,
    hint:
      "Use create_automation (simple manual/webhook workflows) or request_approval for advanced automations your operator must configure in the dashboard.",
  },
  {
    match: /channel management is only available to human/i,
    hint:
      "Channel setup requires a human in the dashboard. You CAN list_channels, send_telegram, and send_discord on channels already connected.",
  },
  {
    match: /only human users can manage agent delegations/i,
    hint:
      "Delegation rules are human-only. You CAN discover_agents, list_my_sub_agents, get_delegation_status, and delegate_task when authorized.",
  },
  {
    match: /cannot (provision|rotate|deactivate) their own signing keys/i,
    hint:
      "Signing keys are provisioned by your human operator. You CAN submit transactions and sign intents when Intents API is enabled.",
  },
  {
    match: /cannot create runtimes/i,
    hint:
      "Cloud runtimes are created by humans. You CAN list_runtimes (if exposed) and use chat tools within an existing runtime.",
  },
  {
    match: /cannot create consensus policies/i,
    hint:
      "Consensus policies require a human. You CAN request_approval with action policy_change for standard access policies on vaults you own.",
  },
  {
    match: /cannot modify card policy/i,
    hint:
      "Card guardrails are human-only. You CAN order_card when cards_enabled is on and list_cards for status.",
  },
  {
    match: /treasury wallets are only available/i,
    hint: "Treasury wallets are human-only. Agents use signing keys and Intents API for on-chain actions.",
  },
];

function extractDetail(text) {
  if (!text) return "Unknown error";
  try {
    const parsed = JSON.parse(text);
    return parsed.detail || parsed.error || parsed.message || text;
  } catch {
    return text.slice(0, 500);
  }
}

/**
 * @param {number} status
 * @param {string} text - raw response body
 * @param {string} operation - e.g. "create_binding"
 * @returns {{ error: string, status?: number, hint?: string }}
 */
function formatApiError(status, text, operation) {
  const detail = extractDetail(text);
  const base = `${operation} failed (${status}): ${detail}`;

  if (status === 403 || status === 401) {
    for (const { match, hint } of HUMAN_ONLY_HINTS) {
      if (match.test(detail)) {
        return { error: base, status, hint };
      }
    }
    if (status === 403) {
      return {
        error: base,
        status,
        hint:
          "This action may require your human operator. Try request_approval or use read/execute tools allowed for agents.",
      };
    }
  }

  return { error: base, status };
}

module.exports = { formatApiError, extractDetail };
