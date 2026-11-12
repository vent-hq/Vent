# vent-hq

**Agent CLI for voice AI development.** Lets coding agents (Claude Code, Cursor, Codex, Windsurf) place real calls against your voice agent and read back transcripts, latency, audio, tool calls, and 60+ computed metrics — so they can iterate on prompts, flows, and platform config based on what actually happened.

Works with **Vapi, Retell, LiveKit, ElevenLabs, Bland, and custom WebSocket endpoints**.

```bash
npx vent-hq@latest init
```

## How it works

1. Your coding agent writes a Vent caller config (`.vent/suite.json`) with a persona and a call goal.
2. It runs `vent-hq run -f .vent/suite.json`. Vent joins the call as a voice caller, drives the conversation, and records everything.
3. Vent returns a single JSON result: full transcript, recorded audio URL, per-turn latency, tool-call trace, and call metadata. Your agent reads it and decides what to change.

The agent is the brain. Vent is the instrument.

## Install

```bash
npx vent-hq@latest init
```

`init` will:
- Authenticate via GitHub (if you have `gh` installed) or open a browser for device-code auth
- Install skill files for Claude Code (`.claude/skills/vent/SKILL.md`), Cursor (`.cursor/rules/vent.mdc`), Codex (`AGENTS.md`), and Windsurf (`.windsurf/skills/vent/SKILL.md`)

After `init`, your coding agent reads the skill file, writes a suite for your agent's platform in `.vent/`, and takes over from there.

## Example suite

```json
{
  "connection": {
    "adapter": "vapi",
    "vapi_assistant_id": "asst_..."
  },
  "calls": {
    "happy-path": {
      "caller_prompt": "You're a customer wanting to book a haircut for Friday at 3pm. Be friendly but a little vague about the date at first.",
      "max_turns": 8
    }
  }
}
```

Set `VAPI_API_KEY` in `.env` and run:

```bash
npx vent-hq run -f .vent/suite.json
```

Swap `adapter` for `retell`, `livekit`, `elevenlabs`, `bland`, or `websocket` to target a different platform. See [the docs](https://docs.vent.dev) for the per-platform connection block.

## Commands

| Command                             | Purpose                                                    |
|-------------------------------------|------------------------------------------------------------|
| `vent-hq init`                      | One-time setup: auth, skill files                          |
| `vent-hq run -f <suite.json>`       | Run a call (or all calls) from a suite, stream results     |
| `vent-hq run -f <s> --call <name>`  | Run a single named call                                    |
| `vent-hq stop <run-id>`             | Cancel a queued or running call                            |
| `vent-hq agent start -f <s>`        | Keep a relay session open for a local WebSocket agent      |
| `vent-hq login` / `logout`          | Manage credentials                                         |

Run `vent-hq <command> --help` for command-specific options.

## What you get back

Every `run` places one call and returns a single JSON object on stdout. Shape:

```json
{
  "run_id": "4ceb8e0a-...",
  "status": "pass",
  "total": 1,
  "calls": [
    {
      "name": "happy-path",
      "status": "completed",
      "duration_ms": 75562,
      "transcript": [
        { "role": "agent", "text": "Hi, thanks for calling Acme Salon. How can I help?" },
        { "role": "caller", "text": "Hey, I'd like to book a haircut for Friday." }
      ],
      "latency": { "response_time_ms": 3154, "p50_response_time_ms": 2980, "max_response_time_ms": 4890, "first_response_time_ms": 4920 },
      "tool_calls": {
        "total": 1, "successful": 1, "failed": 0,
        "observed": [{ "name": "check_availability", "arguments": { ... }, "result": { ... }, "successful": true }]
      },
      "component_latency": { "mean_stt_ms": 648, "mean_llm_ms": 1033, "mean_tts_ms": 321 },
      "signal_quality": { "mean_snr_db": 31.2, "max_clipping_ratio": 0 },
      "call_metadata": {
        "platform": "vapi", "provider_call_id": "...", "recording_url": "https://...",
        "cost": { "total_usd": 0.13, "breakdown": { "stt": 0.01, "llm": 0.03, "tts": 0.02, "transport": 0.02, "vapi": 0.05 } },
        "provider_debug_urls": { "dashboard": "https://dashboard.vapi.ai/calls/..." }
      }
    }
  ]
}
```

`status` is `"error"` (with an `error` message) when Vent could not complete the call, and `end_note` explains an early hang-up.

## Platform notes

- **Vapi, Retell, ElevenLabs** — hosted only. Set the API key + assistant/agent ID in `.env`.
- **LiveKit** — works against local dev agents and LiveKit Cloud with the same config (different `LIVEKIT_URL`). Install [`@vent-hq/livekit`](https://www.npmjs.com/package/@vent-hq/livekit) (Node) or [`vent-livekit`](https://pypi.org/project/vent-livekit/) (Python) for tool-call and component-latency observability.
- **Bland** — supports pathways (`bland_pathway_id`) or inline `task` prompts, optionally with a persona (`persona_id`).
- **Custom (WebSocket)** — point at a hosted endpoint with `agent_url`, or run a local agent with `start_command` + `agent_port`. Vent tunnels audio through a relay so your machine doesn't need a public IP.

Platform credentials are encrypted at rest (AES-256-GCM) and never appear in chat logs or run payloads.

## Links

- [Website](https://venthq.dev)
- [Documentation](https://docs.vent.dev)
- [Source on GitHub](https://github.com/vent-hq/vent)
- [Changelog](https://github.com/vent-hq/vent/blob/main/packages/pub-cli/CHANGELOG.md)
- [@vent_hq on X](https://x.com/vent_hq)

## License

MIT
