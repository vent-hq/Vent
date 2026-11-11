# Contributing to Vent

Thanks for your interest in contributing to Vent.

## Before you start

- Read the [LICENSE](./LICENSE) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
- Open an issue before starting larger changes so implementation direction can be aligned early.
- Keep pull requests focused. Small, reviewable changes are much easier to merge than broad refactors.

## Repository structure

This is a pnpm + Turborepo monorepo:

```
apps/
  api/                    Fastify HTTP API server
  dashboard/              Dashboard (Next.js 15, React 19, Tailwind, shadcn/ui)
  worker/                 BullMQ job processor (voice call execution)

packages/
  adapters/               Voice platform adapters (Vapi, Retell, LiveKit, ElevenLabs, Bland, custom)
  artifacts/              S3/R2 artifact storage (recordings, audio)
  db/                     Drizzle ORM schema + PostgreSQL migrations
  platform-connections/   Platform credential encryption (AES-256-GCM)
  pub-cli/                Published CLI (vent-hq on npm)
  pub-livekit-node/       Published Node helper (@vent-hq/livekit on npm)
  pub-livekit-python/     Published Python helper (vent-livekit on PyPI)
  runner/                 Call execution engine (orchestration, audio analysis)
  shared/                 Shared types, Zod schemas, constants, utilities
  voice/                  Voice processing (VAD, STT via Deepgram)
```

## Local setup

1. Install pnpm (see `packageManager` in `package.json` for the expected version).
2. Install dependencies from the repository root:

   ```
   pnpm install
   ```

3. Start all workspaces in development:

   ```
   pnpm dev
   ```

To work on a specific app or package, run commands from its directory:

```
cd apps/dashboard && pnpm dev
```

## Common commands

Run these from the repository root:

```
pnpm lint          # Lint all packages
pnpm typecheck     # Type-check all packages
pnpm build         # Build all packages and apps
pnpm clean         # Remove all dist/ and .next/ outputs
```

Database:

```
pnpm db:generate   # Generate a Drizzle migration from schema changes
pnpm db:migrate    # Apply pending migrations to DATABASE_URL
```

## Release workflow

Versioning for published packages is managed with Changesets.

```
pnpm changeset add          # Create a changeset for npm package releases
pnpm version-packages       # Apply pending changesets and update changelogs
pnpm release:publish        # Publish all npm packages managed by Changesets
```

Add a changeset whenever you change a published package (`vent-hq`, `@vent-hq/livekit`). The Python package (`vent-livekit`) is versioned independently — bump `packages/pub-livekit-python/pyproject.toml` and `packages/pub-livekit-python/CHANGELOG.md` in the same PR.

## Pull request expectations

- Explain the user-facing or developer-facing impact clearly.
- Include screenshots or recordings for visual changes.
- Add or update tests when behavior changes.
- Update docs or metadata when product behavior changes publicly.
- Avoid unrelated cleanup in the same pull request.

## Code style

- Follow the existing project structure and naming conventions.
- Prefer clear, explicit code over clever abstractions.
- Keep product-facing language consistent with the website and docs.
- Do not commit secrets, credentials, or environment-specific configuration.

## Reporting security issues

Do not open public issues for security vulnerabilities. Email `sgzrov@gmail.com` directly.
