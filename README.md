# 1Claw Runtime Base

The container image every 1Claw-hosted agent runtime actually runs. Public so anyone
running an agent on 1Claw — or thinking about it — can read exactly what's inside the
box: what gets installed, what the entrypoint does before your agent's first line of
code runs, and how each supported framework is wired up.

## What's here

- **`Dockerfile`** — the base image: Node 24 LTS + Python 3, the `@1claw/cli`, and the
  [1Claw Shroud sidecar](https://github.com/1clawAI/1claw-shroud-sidecar) (built from
  source in the same build stage, not fetched as a binary).
- **`entrypoint.sh`** / **`healthcheck.sh`** — what actually runs when a runtime
  container starts, and how its health is checked.
- **`templates/`** — one directory per supported agent framework
  (`hermes`, `openclaw`, `opencode`, `openclaude`, `claude-code`, `codex`, `amp`), plus
  plain `node`, `python`, and `binary` runtimes for bring-your-own-agent images, and a
  `shared/` directory (native agent server, chat bridge) every framework template pulls
  from.
- **`k8s/`** — the Kubernetes manifests used where a runtime isn't a Cloud Run service.
- **`scripts/`** — build/publish helpers.
- **`SETUP.md`** — day-to-day operational notes for this image.

## Building it yourself

The base `Dockerfile`'s build context is the parent of this repo and the sidecar's, so
to build it exactly as CI does, check both out as siblings:

```
packages/
├── runtime-base/          (this repo)
└── 1claw-shroud-sidecar/  (github.com/1clawAI/1claw-shroud-sidecar)
```

```bash
git clone https://github.com/1clawAI/runtime-base.git packages/runtime-base
git clone https://github.com/1clawAI/1claw-shroud-sidecar.git packages/1claw-shroud-sidecar
cd packages
docker build -f runtime-base/Dockerfile -t runtime-base:latest .
```

## Relationship to the main 1Claw repo

This is extracted from [1clawAI/1claw](https://github.com/1clawAI/1claw)'s
`packages/runtime-base`, which vendors it in as a git submodule at the same path. Changes
land here first, then get pulled into the monorepo.
