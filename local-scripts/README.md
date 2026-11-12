# Develop and test locally

If you're making local changes to Vent, you can locally test them against ready voice agents deployed on our supported platforms (found inside `platform-demos`). The API, worker, Postgres, Redis, and SeaweedFS run locally in Docker, and the CLI is built from its source code and run with `node`. For example, when testing the `run` command, run `node packages/pub-cli/dist/index.mjs run -f platform-demos/demo-suites/bland.json`.

## Start

```bash
doppler run --project vent --config dev -- pnpm dev:docker
```

This starts the API, worker, Postgres, Redis, and SeaweedFS in Docker, and builds
the CLI. Doppler `dev` supplies the keys (`DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`,
`JWT_PRIVATE_KEY`).

## Make a call

```bash
doppler run --project vent --config dev -- env \
  VENT_API_URL=http://127.0.0.1:3001 \
  VENT_REFRESH_TOKEN=vent_010101010101010101010101010101010101010101010101 \
  node packages/pub-cli/dist/index.mjs run -f platform-demos/demo-suites/bland.json
```

`VENT_API_URL` points the CLI at your local API. `VENT_REFRESH_TOKEN` is the local
test user's key, copied from `compose.local.yaml`. Doppler `dev` supplies the demo
agent's keys. The call is real, so it uses provider credits. To call another demo
agent, change the suite file.

## After changing code

Rebuild the CLI:

```bash
pnpm --filter vent-hq build
```

Rebuild the API and worker:

```bash
doppler run --project vent --config dev -- \
  docker compose -f compose.local.yaml --profile app up -d --build --no-deps api worker
```

## Call your own agent

Copy a suite from `platform-demos/demo-suites/` and give the CLI that platform's keys:

| Adapter | Keys |
| --- | --- |
| `bland` | `BLAND_API_KEY`, `BLAND_PATHWAY_ID` |
| `elevenlabs` | `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` |
| `livekit` | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` |
| `retell` | `RETELL_API_KEY`, `RETELL_AGENT_ID` |
| `vapi` | `VAPI_API_KEY`, `VAPI_ASSISTANT_ID` |

For a LiveKit agent with named dispatch, add
`"platform": { "livekit_agent_name": "your-agent" }` under
`connection`.

## Logs and stop

```bash
docker compose -f compose.local.yaml logs -f api worker
docker compose -f compose.local.yaml --profile app down
```

Stopping keeps the local database and recordings. How the demo agents are deployed is in
[platform-demos/README.md](../platform-demos/README.md).
