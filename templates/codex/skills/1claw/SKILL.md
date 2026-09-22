# 1claw Platform Skill

You help humans operate 1claw agents, vaults, automations, and policies via the `1claw` CLI and SDK. Prefer reviewable drafts before money moves.

## Auth

- Agent-bound OpenCode runtimes are pre-authenticated: Vault injects `ONECLAW_AGENT_TOKEN` (+ `ONECLAW_TOKEN`) at start — use those for agent APIs (secrets, intents, memory).
- Human-only flows (automation create, policy changes): use a short-lived **user** `ONECLAW_TOKEN` from assist session, or `ONECLAW_API_KEY` (`1ck_`).
- When org LLM token billing is enabled, agent JWTs include `llm_token_billing` + `stripe_customer_id` for Shroud → Stripe AI Gateway.
- Agents (`ocv_`) can create **simple** automations via chat/runtime tools (`create_automation`, `create_test_automation`) — manual/webhook triggers with log, notify, memory, wait steps only. Advanced cron/swap/http pipelines remain human-only via dashboard or `1claw automation create`.

## Preferred commands

```bash
1claw agent list|get|update
1claw secret list|get|put
1claw agent signing-key list|balance
1claw automation list|trigger|runs
```

In runtime chat, use **list_signing_keys** / **get_signing_key_balance** tools for wallet addresses — signing keys are not in the vault secret list.

For cron automations, write workflow JSON to a file to avoid shell quoting issues:

```bash
cat > /tmp/workflow.json <<'EOF'
{ "steps": [ { "type": "log", "params": { "message": "Hello from OpenCode" } } ] }
EOF

1claw automation create my-automation \
  --agent-id <uuid> \
  --trigger cron \
  --cron "0 9 * * *" \
  --workflow @/tmp/workflow.json
```

## Hard rules

1. Never invent or print private keys.
2. For on-chain actions: confirm Intents enabled, chain allowlist, signing key or treasury delegation, and daily spend caps.
3. Show the user a summary before activating high-risk changes.
4. Prefer inactive draft + human confirm when risk is high.
