# SafetySpect demo agents

These fixtures originate from [sgzrov/Vent-test](https://github.com/sgzrov/Vent-test)
commit `d87795068ac706efd204163d99a36b6d2cb7dabf`. They are private workspace
packages and are not published. All business data is fictional.

## What runs where

- `demo-agents/`: shared customer lookup, availability, booking and
  cancellation endpoints. Deployed as Fly app `vent-demo-backend`.
- `demo-db/`: dedicated Fly app `vent-demo-db`, with one Machine and a persistent
  volume. Database: `vent_demo`. It is separate from Vent's production database.
  It has no public database port; the backend connects over Fly's private network.
- `demo-agents/src/livekit/`: TypeScript agent, hosted on LiveKit Cloud in
  the same project as the demo `LIVEKIT_URL`. It registers as `safetyspect-ts` and
  calls the same HTTP business tools as the other platforms. It is a standalone
  package with its own lockfile, outside the pnpm workspace, because LiveKit Cloud
  builds from this directory alone. It is not part of the backend's runtime.
- `demo-agents/scripts/`: create/update the hosted Bland, Vapi, Retell and
  ElevenLabs agents through their platform APIs. They use the shared backend.
- `demo-suites/`: one baseline caller scenario per platform. It looks up James Chen,
  asks about availability, and declines to book, so repeated baseline calls do
  not consume appointment slots.

Vent itself stays in local Docker during development. Run its actual workspace
CLI against the local API to call these deployed agents.

## Credentials

Doppler project `vent`, config `dev`, contains the demo database credentials,
backend URL, and the Deepgram and Anthropic keys the caller uses. Add the relevant platform keys there:

| Platform | Credentials | IDs to retain after setup |
| --- | --- | --- |
| Bland | `BLAND_API_KEY` | `BLAND_PATHWAY_ID`, `BLAND_PERSONA_ID` |
| Vapi | `VAPI_API_KEY` | `VAPI_ASSISTANT_ID` |
| Retell | `RETELL_API_KEY` | `RETELL_AGENT_ID`, `RETELL_LLM_ID` |
| ElevenLabs | `ELEVENLABS_API_KEY` | `ELEVENLABS_AGENT_ID` |
| LiveKit | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Agent name is `safetyspect-ts` in the suite |

Platform setup commands print the IDs to retain in Doppler. Existing IDs select
updates. These commands create demo agents if no existing IDs are supplied.
LiveKit uses the project's inference services and must have sufficient credits.
Secrets are supplied at runtime, not copied into images or committed to Git.

## Create or update hosted agents

Run from the repository root after adding that platform's key:

```bash
doppler run --project vent --config dev -- pnpm --filter @vent/demo-backend setup:bland
doppler run --project vent --config dev -- pnpm --filter @vent/demo-backend setup:vapi
doppler run --project vent --config dev -- pnpm --filter @vent/demo-backend setup:retell
doppler run --project vent --config dev -- pnpm --filter @vent/demo-backend setup:elevenlabs
```

Keep the resulting IDs in `dev` before running calls or repeating setup.

## Deployments

From the root, deploy the database and backend to Fly, and the LiveKit agent to
LiveKit Cloud:

```bash
fly deploy . --config platform-demos/demo-db/fly.toml --remote-only --ha=false
fly deploy . --config platform-demos/demo-agents/fly.toml --remote-only --ha=false
(cd platform-demos/demo-agents/src/livekit && lk agent deploy)
```

The database and backend apps and their secrets are already provisioned. The
LiveKit agent's ID and project are in its `livekit.toml`; link that project to
the CLI once with `lk project add` using the demo LiveKit credentials. LiveKit
Cloud injects those credentials into the agent itself. No update to Vent's
production API or worker is required.

The backend initializes its PostgreSQL schema and missing sample customers on
startup. Initialization preserves existing customers and bookings. PostgreSQL
uses a sequence for booking IDs and a unique constraint for confirmed slots so
concurrent requests from different platforms cannot double-book a slot. Demo
booking confirmations do not send real SMS messages.

## Run a call through local Vent

```bash
doppler run --project vent --config dev -- pnpm dev:docker

doppler run --project vent --config dev -- env \
  VENT_API_URL=http://127.0.0.1:3001 \
  VENT_REFRESH_TOKEN=vent_010101010101010101010101010101010101010101010101 \
  node packages/pub-cli/dist/index.mjs run -f platform-demos/demo-suites/elevenlabs.json
```

Select `bland.json`, `vapi.json`, `retell.json` or `livekit.json` for the other
platforms. Credentials are resolved by the CLI and encrypted in Vent's local
run record. API URL and auth overrides are applied after Doppler, keeping calls
on the local Vent backend. Calls use real provider credits.

## Verify

```bash
curl --fail https://vent-demo-backend.fly.dev/health
pnpm --filter @vent/demo-backend test
pnpm typecheck
pnpm --dir platform-demos/demo-agents/src/livekit typecheck
```

Backend integration tests run against the deployed demo backend, exercise all
provider request formats, cross-platform booking visibility, cancellation, and
concurrent slot contention. They cancel bookings they create.
Real calls still need to be reviewed for
transcript accuracy, recording quality, tool behavior, and timing.
