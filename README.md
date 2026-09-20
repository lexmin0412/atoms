<div align="center">
  <h1 align="center">Another Atoms</h1>

  <p align="center">
    <strong>Turn a sentence into full-stack app — Built in sandbox, Previewed live, Published in one click.</strong>
  </p>

  <p align="center">
    Inspired by <a href="https://atoms.dev"><strong>Atoms</strong></a>.
  </p>

  <p align="center">
    Built with React 19, Hono, Node 22, Docker Sandbox, and Vercel AI SDK.
  </p>

  <p align="center">
    <a href="https://atoms.lexmin.cn"><strong>Live</strong></a> ·
    <a href="#features"><strong>Features</strong></a> ·
    <a href="#architecture"><strong>Architecture</strong></a> ·
    <a href="#in-action"><strong>In Action</strong></a> ·
    <a href="#roadmap"><strong>Roadmap</strong></a> ·
    <a href="#documentation"><strong>Documentation</strong></a>
  </p>

  <p align="center">
    English | <a href="./README.zh-CN.md">简体中文</a>
  </p>

  <br/>

  <p align="center">
    <a href="https://github.com/lexmin0412/atoms/actions/workflows/ci.yml">
      <img src="https://github.com/lexmin0412/atoms/actions/workflows/ci.yml/badge.svg" alt="CI">
    </a>
    <a href="LICENSE">
      <img src="https://img.shields.io/github/license/lexmin0412/atoms?color=blue" alt="License">
    </a>
    <img src="https://img.shields.io/badge/node-22-3c873a" alt="Node 22">
    <img src="https://img.shields.io/badge/pnpm-10-f69220" alt="pnpm 10">
  </p>
</div>

<br/>

![Workspace: live preview on the left, conversation and tool calls on the right](docs/screenshots/workbench.jpg)

> Live: <https://atoms.lexmin.cn> — sign up and it works (monthly credits are granted automatically).
> Try asking for: "Build a Pomodoro timer with a dark theme and a settings panel."

## Features

- **Conversation-driven generation** — the agent iterates inside the sandbox using file tools and `run_command`, producing a React/Vite frontend plus an optional Hono backend
- **Real execution** — `pnpm install` and `pnpm -r build` actually run inside an isolated container; what it builds is what you preview
- **Live preview** — build artifacts are served on a `dev-<id>.<domain>` subdomain and refresh automatically; when the app has a backend, its container starts too and the frontend can call it
- **Full workspace** — conversation, tool cards, command output, file tree, source editor (optimistic locking) and a database viewer (dev / prod)
- **Skills** — built-in and user-defined skills, invoked explicitly with `/` or matched automatically by description; command-line tools a skill needs are installed inside the sandbox on first use
- **One-click publishing** — artifacts are hosted, each app gets its own Postgres schema, and a long-running backend container serves `<id>.<domain>`; apps can be unlisted at any time
- **Credits metering** — priced by token (input / output / cache), topped up monthly, with a graceful stop and explanation when the budget runs out
- **Context management** — history is trimmed and summarized above a threshold (only what is sent to the model is compacted; transcripts stay complete), with live context usage shown in the UI
- **Mobile-ready** — drawer navigation, single-column workspace, safe-area and touch target handling

## Architecture

### Overview

**Control plane and data plane are separated and live in different trust domains.**

```
Machine A (control plane, 2 vCPU / 2 GB)        Machine B (data plane, 2 vCPU / 4 GB)
├─ React SPA (static, served by nginx)          ├─ Sandbox service (Hono :4000, loopback only)
├─ Hono BFF (:3010)                             │   └─ Docker: one isolated container per project
│   ├─ Agent loop (Vercel AI SDK v7)            │       non-root / cap-drop / memory·CPU·PID limits
│   ├─ Holds the LLM key (B holds none)         │       egress allowlist: DNS/80/443 + A's DB port
│   ├─ Postgres: platform DB (source of truth)  └─ App containers: dev preview / published apps
│   ├─ App DB: one schema + role per project
│   └─ Runtime adapter ── SSH tunnel (HMAC) ─────┘
```

**Key constraints**: the control plane **never executes generated code**; the data plane **holds no secrets**.
A sandbox escape still yields no keys and no platform data.

### Tech stack

| Layer | Choices |
|---|---|
| Frontend | React 19 + Vite + TypeScript + Tailwind v4 + AI SDK (`@ai-sdk/react`) |
| Backend | Hono + Node 22 + Postgres + Vercel AI SDK v7 |
| Model | OpenCode Go (`@ai-sdk/openai-compatible`, default `deepseek-v4.1-flash`) |
| Sandbox | Docker (`node:22-bookworm-slim` + pnpm), HMAC-signed calls, SSH tunnel |
| Deployment | nginx + pm2 + Let's Encrypt + object storage (COS, with a local-directory fallback) |

### Design trade-offs

| Trade-off | Decision and rationale |
|---|---|
| Shape of generated apps | A fixed pnpm workspace (`apps/web` + optional `apps/api`) rather than arbitrary projects — keeps build, preview, publish and rollback predictable |
| Isolation boundary | Separate control/data planes, one container and one database role per project; we accept an extra network hop rather than run untrusted code on the control plane |
| Preview & publish | Dedicated subdomains (`dev-<id>` / `<id>`) instead of same-origin paths — removes cross-app XSS and cookie-scope problems up front |
| Source of truth | The platform database owns the source; the sandbox is an execution copy. A lost workspace can be rebuilt from the DB at the cost of a re-install (mitigated by a shared pnpm store) |
| Context | Trim, never delete: older history is summarized above a threshold while the transcript stays complete and readable |

### Project structure

```
apps/
  api/       # Control-plane BFF: auth, projects, agent loop, context management, runtime adapter
  web/       # React workspace (skills, database viewer, file manager)
  sandbox/   # Data-plane sandbox service (Docker orchestration + file/exec API)
packages/
  shared/    # Shared types (Runtime interface, DTOs, pure helpers)
deploy/
  nginx/     # Site config (SSE without buffering, security headers)
  scripts/   # Operations scripts (database backup, tunnel watchdog)
```

## In Action

### Conversation-driven generation with live preview

<img src="docs/screenshots/workbench.jpg" width="100%" alt="Workspace">

The left side shows the live preview of what the agent built (refreshed when build artifacts change), with tabs for
the file tree and a source editor. The right side is the conversation and tool calls; the top-right corner shows
**context usage / model window** and the credit balance.

### What generated apps look like

<img src="docs/screenshots/generated-app-timer.jpg" width="100%" alt="Generated Pomodoro app">

This Pomodoro timer was generated by the platform and published with one click:
<https://88561f03-48bc-4541-9b4f-0301658ebc77.atoms.lexmin.cn>

### Skills

<img src="docs/screenshots/skills.jpg" width="100%" alt="Skill management">

Built-in skills (read-only, copyable) sit alongside user-defined ones. Command-line tools declared by a skill are
installed into the sandbox on first use and reused across container recreation.

### Mobile

<p align="center"><img src="docs/screenshots/mobile.jpg" width="340" alt="Mobile"></p>

### Quick start

**Hosted**: open <https://atoms.lexmin.cn>, sign up, create a project, describe what you want, watch the preview,
then hit **Publish** to get a standalone URL.

**Local**:

```bash
pnpm install
pnpm -r typecheck && pnpm lint && pnpm fmt:check && pnpm test   # quality gates, no external services needed

cp .env.example .env      # fill DATABASE_URL / APP_DATABASE_URL / OPENCODE_GO_API_KEY / SANDBOX_*
pnpm --filter @atoms/api db:init
pnpm dev                  # starts api(:8787) and web(:5173)
```

Generating, previewing and publishing require a sandbox host with Docker; deployment steps live in
[.agents/skills/atoms-deploy/](./.agents/skills/atoms-deploy/) and [docs/architecture.md](./docs/architecture.md).

## Roadmap

**Current limitations**

- The sandbox relies on Docker isolation (no gVisor yet); the egress allowlist is IP/port based rather than per-domain
- Concurrency caps: 4 development sandboxes and 5 long-running published apps (idle sandboxes are reclaimed, workspace files are kept)
- No web console for operations: granting credits and querying usage go through a CLI (`pnpm --filter @atoms/api credits …`)
- No email verification or password recovery; no real billing; no team collaboration or code rollback

**Priorities**

1. **Observability & reliability** — request-level tracing, error aggregation and alerting (today: logs + a watchdog)
2. **Generation quality** — requirement clarification and a phased flow (requirements → plan → implement → self-check gates), treating "build passes / endpoint reachable" as hard acceptance criteria
3. **Capabilities** — MCP for external integrations (credentials stay on the control plane) and multiple agent roles, reusing the existing prompt assembly and skills
4. **Isolation** — gVisor / Firecracker, per-domain egress allowlists
5. **Collaboration & operations** — team spaces, real billing, an admin console

## Documentation

- [docs/architecture.md](./docs/architecture.md) — system architecture (authoritative)
- [docs/operations.md](./docs/operations.md) — operations and reliability (watchdog, backups, troubleshooting)
- [docs/security-audit.md](./docs/security-audit.md) — security audit and fixes
- [docs/roadmap.md](./docs/roadmap.md) — roadmap and milestones
- [docs/iterations/](./docs/iterations/) — per-iteration plans and outcomes
- [AGENTS.md](./AGENTS.md) — conventions for AI collaborators

License: [MIT](./LICENSE)
