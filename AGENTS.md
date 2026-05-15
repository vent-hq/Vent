# AGENTS.md

## Build and Development Commands

This project uses **pnpm** (>=9.0.0) as the package manager and **Turbo** for monorepo orchestration. All commands run from the repository root.

### Installation
```bash
pnpm install                    # Install all dependencies
```

### Build & Dev
```bash
pnpm build                      # Build all packages and apps (Turbo)
pnpm dev                        # Watch mode with hot reload for all apps
pnpm typecheck                  # Run TypeScript type checking across all packages
pnpm clean                      # Remove all dist/ and .next/ outputs
```

### Database
```bash
pnpm db:generate                # Generate new Drizzle migration from schema changes
pnpm db:migrate                 # Run pending migrations against DATABASE_URL
```

### Deployment (Fly.io)
```bash
pnpm deploy:api                 # Deploy API to Fly.io
pnpm deploy:worker              # Deploy worker to Fly.io
pnpm deploy:dashboard           # Deploy dashboard to Fly.io
pnpm deploy:all                 # Deploy API first, then worker + dashboard in parallel
```

### Releases
```bash
pnpm changeset add                       # Create a changeset for npm package releases
pnpm version-packages                    # Apply pending changesets and update changelogs
pnpm release:publish                     # Publish all npm packages managed by Changesets
python -m build packages/livekit-python  # Build the Python package locally
```

### CLI (published as `vent-hq`)
```bash
pnpm --filter vent-hq build              # Bundle CLI to dist/index.mjs
npx vent-hq init                         # Bootstrap auth + install skill files + scaffold suite
npx vent-hq run -f <suite.json>          # Run calls from a suite and stream results
npx vent-hq agent start -f <config.json> # Start persistent relay session for local agent
npx vent-hq login                        # Device auth flow via browser
npx vent-hq logout                       # Remove saved credentials
```

## Architecture Overview

### Core Concepts
- **Vent** gives coding agents (Claude Code, Cursor, Codex, Windsurf) the ability to call, hear, and evaluate voice AI agents. The coding agent uses Vent to make real calls against your agent, reads back results (transcripts, latency, audio quality, tool calls), and adapts code and platform config based on what it observes. Designed to be used iteratively — describe what your voice agent should do, let the coding agent work, come back to a fully working agent.
- **Adapters** connect to agents on platforms (Vapi, Retell, LiveKit, ElevenLabs, Bland) or to custom endpoint / local agents (raw WebSocket via relay). Platform adapters require API keys, encrypted at rest with `PLATFORM_CONNECTIONS_MASTER_KEY`.

### Monorepo Structure
```
apps/
├── api/                    # Fastify HTTP API server (port 3000)
├── dashboard/              # Next.js 15 frontend (React 19, Tailwind, shadcn/ui)
└── worker/                 # BullMQ job processor (voice call execution)

packages/
├── adapters/               # Voice platform adapters
├── artifacts/              # S3/R2 artifact storage (recordings, audio)
├── cli/                    # Published CLI (vent-hq on npm)
├── db/                     # Drizzle ORM schema + PostgreSQL migrations
├── livekit/                # Published Node helper (@vent-hq/livekit on npm)
├── livekit-python/         # Published Python helper (vent-livekit on PyPI)
├── platform-connections/   # Platform credential encryption (AES-256-GCM)
├── relay-client/           # WebSocket relay for local agent tunneling
├── runner/                 # Call execution engine (orchestration, audio analysis)
├── shared/                 # Shared types, Zod schemas, constants, utilities
└── voice/                  # Voice processing (VAD, STT via Deepgram)
```

### Request Flow
Each `vent run` executes a single call. Run N calls in parallel via separate shell commands.

1. CLI submits call via `POST /runs/submit`
2. API validates config (Zod), checks usage limits, enqueues to per-user BullMQ queue
3. Worker picks up job, decrypts platform credentials, creates audio channel via adapter
4. Call executes with conversation turns, progress streams via HTTP callbacks to API
5. API broadcasts events via Redis pub/sub → SSE to CLI
6. Results stored and returned to the coding agent

## Published Packages

- Only three packages publish to npm/PyPI; everything else in `apps/*` and `packages/*` is internal/private.
- `packages/cli` -> `vent-hq` (npm, Changesets)
- `packages/livekit` -> `@vent-hq/livekit` (npm, Changesets)
- `packages/livekit-python` -> `vent-livekit` (PyPI, independent versioning)
- `packages/cli` and `packages/livekit` rebuild ignored `dist/` in `prepack` before npm publish.

## Release Triggers

- npm: add a `.changeset`, merge to `main`, then merge the auto-generated `chore: version packages` PR from `.github/workflows/release.yml`.
- Python: bump `packages/livekit-python/pyproject.toml` and `packages/livekit-python/CHANGELOG.md`, then merge to `main`; `.github/workflows/release-python.yml` publishes if `PYPI_API_TOKEN` is set.

## Environment Variables
- `DATABASE_URL` — PostgreSQL connection string
- `REDIS_URL` — Redis/Upstash for BullMQ + pub/sub
- `DASHBOARD_URL` — Frontend URL for CORS and device auth redirects
- `NEXT_PUBLIC_API_URL` — API URL for dashboard client-side requests
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI` — WorkOS OAuth callback URL
- `RUNNER_CALLBACK_SECRET` — HMAC secret for worker→API callbacks
- `RUNNER_PUBLIC_HOST`, `RUNNER_LISTEN_PORT` — Public host/port for Bland webhook callbacks
- `WORKER_TOTAL_CONCURRENCY` — Required total active run budget for one worker Machine across all owned user queues. Keep this at or below what one worker box can actually sustain.
- `FLEET_MAX_ACTIVE_RUNS` — Optional fleet-wide cap on concurrent runs across all machines (default 45). Set to match the lowest external provider concurrency limit (e.g. Deepgram TTS streaming). API returns 429 when the cap is reached.
- `WORKER_METRICS_PORT` — Optional internal Prometheus scrape port for worker metrics (default `9091`)
- `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD` — WorkOS auth
- `PLATFORM_CONNECTIONS_MASTER_KEY` — 32-byte hex key for encrypting platform credentials (`openssl rand -hex 32`)
- `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY` — AI/voice providers
- `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION` — Cloudflare R2

## Code Style
- TypeScript strict mode, ES2022 target, Node.js >= 20
- Zod schemas for all API boundaries (`packages/shared/src/schemas.ts`)
- Types centralized in `packages/shared/src/types.ts`

## Commit Style
`type: description` — 8 words or fewer (excluding type prefix). Bisect commits: every commit is a single logical change. Split rename/refactor/feature/test into separate commits.

| Type       | When to use                                              |
|------------|----------------------------------------------------------|
| `feat`     | New user-facing feature                                  |
| `fix`      | Bug fix                                                  |
| `refactor` | Code restructuring (no feature or fix)                   |
| `perf`     | Performance improvement                                  |
| `docs`     | Documentation only                                       |
| `test`     | Add or modify tests only                                 |
| `chore`    | Maintenance (tooling, deps, scripts) — no runtime change |
| `build`    | Build system / deps affecting build output               |
| `ci`       | CI configuration changes                                 |
| `style`    | Formatting only (no logic change)                        |
| `revert`   | Revert a prior commit                                    |

## Project Rules

- **PRODUCTION-ONLY fixes. No localhost.** Test against deployed services, not local dev servers.
- **Don't worry about backward compatibility.** Early-stage project — break things if it leads to a cleaner result.
