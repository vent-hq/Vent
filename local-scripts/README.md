# Test deployed voice agents with local Vent

The CLI runs on your Mac. Docker runs Vent's API, worker, PostgreSQL, Redis and
SeaweedFS recording storage. The worker connects to your deployed voice agent
using the existing Bland, LiveKit, ElevenLabs, Vapi or Retell adapter. The caller
uses Deepgram (speech) and Anthropic (what to say), the same as production. This
setup does not run a local demo agent.
The API and worker use their deployment Dockerfiles.

## Start Vent

Requirements: Docker, Node 22+, pnpm and the Doppler CLI. The worker needs
`DEEPGRAM_API_KEY` and `ANTHROPIC_API_KEY` (both in Doppler `dev`). The
target agent's credentials are supplied to the CLI when submitting a call; they
are encrypted in the local database for the worker. Your deployed agent uses its
own configured model providers.

The API also requires `JWT_PRIVATE_KEY` in Doppler: a PKCS#8 RSA private key of at
least 2048 bits. The CLI signs in with a long-lived refresh credential and renews
15-minute access JWTs automatically. Revoking a credential stops renewal;
already-issued JWTs remain valid until they expire.

```bash
doppler run --project vent --config dev -- pnpm dev:docker
```

The command starts the data services, migrates and seeds the isolated local
`vent_local` database, builds and starts the API and worker, and builds the CLI.
Production database, Redis, object storage and CLI auth settings are overridden
with local settings.

The Docker API and worker run built code without automatic restarts. After code
changes, rebuild and replace them with:

```bash
doppler run --project vent --config dev -- \
  docker compose -f compose.local.yaml --profile app up -d --build --no-deps api worker
```

## Select the deployed agent

Create a suite JSON file using the same format as normal Vent calls. For example,
to test an existing ElevenLabs agent:

```json
{
  "connection": {
    "adapter": "elevenlabs"
  },
  "calls": {
    "basic_conversation": {
      "caller_prompt": "Call this business, ask what services it offers, ask one relevant follow-up question, then thank the agent and say goodbye.",
      "max_turns": 6,
      "language": "en"
    }
  }
}
```

Use a caller prompt appropriate to your agent. Set the adapter and provide these
variables in the CLI's environment (for example, from Doppler):

| Adapter | Required CLI environment | Extra suite configuration |
| --- | --- | --- |
| `elevenlabs` | `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` | None |
| `bland` | `BLAND_API_KEY`, `BLAND_PATHWAY_ID` (`BLAND_PERSONA_ID` is optional alongside it) | None |
| `livekit` | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | For named dispatch, add `"platform": {"provider": "livekit", "livekit_agent_name": "your-agent-name"}` under `connection` |
| `vapi` | `VAPI_API_KEY`, `VAPI_ASSISTANT_ID` | None |
| `retell` | `RETELL_API_KEY`, `RETELL_AGENT_ID` | None |

An example LiveKit connection is:

```json
{
  "adapter": "livekit",
  "platform": {
    "provider": "livekit",
    "livekit_agent_name": "your-agent-name"
  }
}
```

Omit `livekit_agent_name` if your deployed agent uses automatic dispatch.

## Run the actual CLI

Run from the repository root, replacing `path/to/suite.json` with your file:

```bash
doppler run --project vent --config dev -- env \
  VENT_API_URL=http://127.0.0.1:3001 \
  VENT_ACCESS_TOKEN= VENT_REFRESH_TOKEN=vent_010101010101010101010101010101010101010101010101 \
  node packages/pub-cli/dist/index.mjs run -f path/to/suite.json
```

Use the Doppler config containing your target platform's credentials for this
command. The local URL and token are applied after Doppler to ensure that its
production defaults cannot redirect the call to the deployed Vent API.
The test makes a real call to the deployed agent and uses provider credits.
The worker sends results through the local API to the CLI; recordings use the
local object store. No CLI publication or extra repository is required.

## Logs and shutdown

```bash
docker compose -f compose.local.yaml logs -f api worker
docker compose -f compose.local.yaml --profile app down
```

Stopping keeps the local database and recordings.

## Demo agents

The imported demo agents, Fly deployments and platform setup commands are
documented in [demos/README.md](../demos/README.md).
