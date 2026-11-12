<p align="center">
  <img src=".github/logo.png" alt="Vent" width="64" />
</p>

<p align="center">
  The voice AI eval loop for coding agents.<br />
  Real calls, in-call measurement, autonomous iteration.
</p>

<p align="center">
  <a href="https://github.com/sgzrov/Vent/stargazers"><img src="https://img.shields.io/github/stars/sgzrov/Vent?style=flat&labelColor=4A4A4A&color=3B82F6" alt="GitHub stars" /></a>
  <a href="https://www.npmjs.com/package/vent-hq"><img src="https://img.shields.io/npm/v/vent-hq?style=flat&labelColor=4A4A4A&color=A4D60E" alt="npm" /></a>
  <a href="https://github.com/sgzrov/Vent/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-3B82F6?style=flat&labelColor=4A4A4A" alt="License" /></a>
</p>

<p align="center">
  See our launch on <a href="https://x.com/stephangazarov/status/2050137498735747473?s=20">X</a>!
</p>

---

### What is Vent?

Vent is a CLI for coding agents that lets them place calls and evaluate voice agents through vocal agent-to-agent communication. It works with Vapi, Retell, LiveKit, ElevenLabs, Bland, and custom endpoints.

### How It Works

When your coding agent runs `vent-hq run`, Vent places a real call to your voice agent, measures the entire call from inside, and returns a structured result. Most voice eval tools probe from outside; Vent runs inside. Think of it as a CLI version of Hamming, Roark, or Coval.

Under the hood, a Claude Haiku 4.5 caller LLM drives the conversation, speaking via Deepgram Aura-2 over WebSocket or WebRTC. Vent listens through a vendored TEN VAD WASM module (no external service call) and Deepgram nova-3 STT across seven languages. Everything that happened inside the call comes back — transcript, audio quality, latency at every layer (per reply, with its STT/LLM/TTS breakdown), every tool and MCP call, every transfer, pathway and flow decisions, agent state transitions, provider warnings, cost, debug URLs, and the recording — as structured JSON in `.vent/runs/` with the audio in Tigris (S3-compatible storage), accessible through a signed URL.

### Install

```bash
npx vent-hq@latest init                             # Agent auto-setup: auth, skills
```

The `init` command lets the agent automatically log in via GitHub, generate an access token, and install skill files. The coding agent then writes the suite for your agent's platform in `.vent/`. For access without GitHub, run `login` and then `init`.

### Quick Start

```bash
npx vent-hq@latest init                             # Auto-setup
npx vent-hq run -f .vent/suite.json                 # Run all calls, stream SSE
npx vent-hq run -f .vent/suite.json --call foo      # Run a specific call
npx vent-hq stop <run-id>                           # Cancel a queued or active run
```

A minimal `.vent/suite.json`:

```json
{
  "connection": {
    "adapter": "vapi",
    "platform_connection_id": "..."
  },
  "calls": {
    "refund_request": {
      "caller_prompt": "Ask for a refund on order #1234. Get frustrated if pushed back.",
      "persona": { "pace": "fast", "clarity": "clear" },
      "max_turns": 8,
      "language": "en",
      "voice": "female"
    }
  }
}
```

### Platforms

Credentials are encrypted at rest with **AES-256-GCM** and never appear in chat or run payloads.

#### Vapi, Retell, ElevenLabs

Hosted only. Set your API key and agent/assistant ID, save as a platform connection, reference by `platform_connection_id`.

#### LiveKit

Test local agents in dev mode or deployed agents on LiveKit Cloud — same config, different `LIVEKIT_URL`. Target a specific agent with `livekit_agent_name`.

Since LiveKit does not forward events natively, install our first-class instrumentation libraries — [`@vent-hq/livekit`](https://www.npmjs.com/package/@vent-hq/livekit) (Node) or [`vent-livekit`](https://pypi.org/project/vent-livekit/) (Python).

One line:

```ts
const vent = instrumentLiveKitAgent({ ctx, session });
```

```python
vent = instrument_livekit_agent(ctx=ctx, session=session)
```

Both packages hook the LiveKit Agents `AgentSession` lifecycle (`metrics_collected`, `function_tools_executed`, `conversation_item_added`, `close`) and publish to 6 dedicated Vent DataChannel topics. Without the instrumentation, Vent still captures agent state transitions and transcripts directly from the Agents SDK.

#### Bland

Test pathways (`bland_pathway_id`), personas (`persona_id`), or inline prompts (`task`).

#### Custom

Point Vent at a hosted endpoint with `agent_url`, or test a pure-localhost agent with `start_command` + `agent_port` — Vent spawns your agent and tunnels audio through a relay so you don't need a public IP. Your agent emits `tool_call`, `vent:timing`, `vent:call-metadata`, `vent:transcript`, `vent:transfer`, `vent:debug-url`, `vent:warning`, `speech-update`, and `end-call` for full observability.

For parallel calls, share one relay session — each call gets its own multiplexed connection through the relay, so the agent isn't respawned for every run:

```bash
npx vent-hq agent start -f .vent/suite.json
npx vent-hq run -f .vent/suite.json --session <session-id>
npx vent-hq agent stop <session-id>
```
