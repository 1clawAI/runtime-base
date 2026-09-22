# Shared runtime template assets

`chat-bridge.js` is the canonical OpenAI-compatible chat server for hermes /
openclaw / openclaude / opencode templates. Docker build context is per-template, so each
template directory holds a copy — keep them in sync when editing.

`user-port.sh` is shared across chat templates (copied via Dockerfile from
`shared/`). It starts chat-bridge on USER_PORT alongside optional STARTUP_COMMAND
and waits for `/health` before the entrypoint blocks.

`hermes-agent-start.sh` and `openclaw-agent-start.sh` wire official integrations:
- Hermes: [1clawAI/1claw-hermes](https://github.com/1clawAI/1claw-hermes) patches
  `~/.hermes` then runs `hermes gateway`.
- OpenClaw: [@1claw/openclaw-plugin](https://github.com/1clawAI/1claw-openclaw-plugin)
  then `openclaw gateway` on port 18789.

Default STARTUP_COMMAND is set in the template entrypoint and persisted by Vault
on create when the client omits `startup_command`.
