---
name: vent
description: Place real calls against the user's voice agent to verify recent code changes worked end-to-end. Trigger on test requests or after any non-trivial voice-agent change.
---

# Vent - Voice Agent Calls

## When to Test

Vent is the voice CI gate. Auto-trigger a call after any non-trivial voice-affecting change — don't wait to be asked. Non-trivial means anything that affects what the caller hears, how the agent responds, what tools are called, how the call routes, or audio timing: prompt rewrites or sections (not one-word tweaks), tool schema or handler changes, state/memory logic, transfer logic, provider/audio config, platform integration, and any voice-behavior bug fix. One-line copy or comment edits don't need a call.

Before launching, scan `.vent/runs/` for unresolved issues from prior runs (failing status, regressions, warnings, latency jumps); fix in-scope ones as part of this change and verify they're resolved by the new run, surface out-of-scope ones rather than silently leaving them. The task is not done until you've reviewed the transcript, tool calls, and observed behavior and judged that the change works — Vent's `status` and exit code only reflect pipeline completion, not mission success.

## Autonomous Iteration

**Default: iterate.** Run a fix → Vent-call → fix → Vent-call loop whenever a call surfaces a fixable issue. Don't report a failure (or a degraded-quality success) back to the user before attempting to fix it — they want the agent working, not a diagnosis. After each call, if the result reveals a problem you can fix with a concrete plan, apply the fix and run again. Fixable issues include: tool schema or registry gaps, missing handlers, prompt phrasing, **STT vocabulary mismatches** (e.g. domain terms misheard — Deepgram `keyterms`, custom vocabulary, prompt-level term lists), **latency tunables** (endpointing thresholds, preemptive generation, model selection), and audio quality config. If you'd be guessing at the next attempt, stop and ask the user instead of trying.

**"Mission success but with quality problems" still requires iteration.** If the call ran end-to-end but had noticeably bad latency, STT mishearing the agent's domain vocabulary, audio artifacts, or any other caller-experience degradation that has a concrete fix, the call is *not done* — apply the fix and re-run. Don't downgrade fixable problems to "observations" or "things worth flagging." The pipeline running cleanly is the floor, not the ceiling.

**Never ask permission to iterate.** "Want me to apply this and re-run?" / "Should I fix it?" / "Let me know if you want me to..." — these are skill violations. If you have a concrete fix, apply it and run the next call. The user opts out by saying so explicitly; silence is not opt-out.

Stop iterating and report when one of:

- The next call confirms the fix worked AND no further fixable issues remain (success — done).
- The same fix fails twice (your hypothesis is wrong; ask the user).
- The failure mode shifts between attempts (you're chasing a moving target).
- You can't justify the next call against its provider cost — each call spends real money and provider quota.

If the user explicitly opts out ("just report", "don't iterate", "stop after the first call", "I'll fix it myself"), respect that — run once, report, stop. Otherwise iterate by default. The first time you start an autonomous loop in a session, mention it once so the user knows it's happening (e.g. "the call surfaced X — fixing and re-running; I'll report back when it converges or stops making progress").

## Windsurf Execution

Vent calls typically take 30 seconds to 2 minutes. Each `vent-hq run` is one shell tool call — wait for stdout (the JSON result) before responding. Don't background; use the JSON returned by `npx vent-hq run` directly. If Cascade's auto-execution level prompts for approval on `npx vent-hq` commands, ask the user to add `npx vent-hq *` to the workspace allow list once so subsequent calls flow without interruption.

Cascade runs shell tool calls in parallel within a turn — for multiple calls from one suite, issue each named call as its own separate shell tool call in the same turn (do not combine them with `&` and `wait`):

```bash
npx vent-hq run -f .vent/suite.vapi.json --call happy-path
npx vent-hq run -f .vent/suite.vapi.json --call tool-path
```

Stay within Cascade's per-turn parallel-tool-call budget — fan out at most ~6 calls in one turn and respect the provider concurrency caps below.

## Workflow

1. Identify the behavior under test. Read enough of the agent codebase to understand its system prompt, tools, handlers, routes, provider config, platform wiring, and expected handoffs.
2. Reuse an existing `.vent/suite.<adapter>.json` when possible. If `.vent/` contains multiple suites, inspect `connection.adapter` and report which suite file produced the result.
3. Create or update a suite only when the existing calls do not cover the changed behavior. Name calls after real flows, for example `reschedule-appointment`, not `call-1`.
4. If the suite uses `start_command`, start one shared local session first with `npx vent-hq agent start -f .vent/suite.<adapter>.json`, then pass `--session <session-id>` to each run.

   **For locally-run LiveKit agents: every run requires killing *all* workers, starting one fresh worker, and waiting a full 60 seconds before submitting.** Unconditional — LiveKit Cloud round-robins across registered workers, so a single survivor with a dead inference subprocess fails ~N-1 of N calls. Don't rely on `pkill -f <path-pattern>`; bare command lines like `node --import tsx agent.ts dev` won't match a path filter. Use `ps aux | grep -E "node.*agent\.ts|@livekit/agents.*ipc"`, `kill -9` by PID, re-run `ps` to confirm zero survivors, then start the fresh worker. Skipping the 60s wait fails with `did not publish audio track`; if that error appears alongside `Error [ERR_IPC_CHANNEL_CLOSED] from InferenceProcExecutor.doInference` in the agent log right after a "running EOU detection" line, that's a straggler — redo the kill sweep. Hosted LiveKit Cloud agents don't need any of this; run normally.
5. Pick which call(s) to run based on the change. Fixed bug: replay the failing scenario. Changed tool: include a call that triggers that tool. Prompt or routing change: include the relevant happy path and any important edge path.
6. Compare against the previous JSON in `.vent/runs/` when validating a fix or regression. Check status flips, latency jumps, tool-call success drops, cost jumps, and transcript divergence. Correlate with `git diff` between saved `git_sha` values when available; skip if no previous run exists.

## Commands

```bash
npx vent-hq init                                  # First-time setup (auth + skill install + starter suite)
npx vent-hq login                                 # Log in to existing account
npx vent-hq login --status                        # Print whether credentials are present
npx vent-hq logout                                # Remove saved credentials from ~/.vent/credentials
npx vent-hq run -f .vent/suite.X.json             # Run a single-call suite
npx vent-hq run -f .vent/suite.X.json --call NAME # Run one named call from a multi-call suite
npx vent-hq run ... --session <session-id>        # Add to any run; routes through an existing local relay session
npx vent-hq run ... --verbose                     # Add to any run; include verbose debug fields
npx vent-hq stop <run-id>                         # Cancel a queued or running run
npx vent-hq agent start -f .vent/suite.X.json     # Start a shared local relay session
npx vent-hq agent stop <session-id>               # Stop a shared local relay session
```

If `~/.vent/credentials` is missing and `VENT_ACCESS_TOKEN` is not set, run `npx vent-hq init`. For an existing account, run `npx vent-hq login` or set `VENT_ACCESS_TOKEN`.

## Suite Config

Suites live in `.vent/suite.<adapter>.json`. `connection` is declared once per suite. `calls` is a named map, and each key becomes the call name used with `--call`.

Local websocket suite:

```json
{
  "connection": {
    "adapter": "websocket",
    "start_command": "npm run start",
    "health_endpoint": "/health",
    "agent_port": 3001
  },
  "calls": {
    "happy-path": {
      "caller_prompt": "You are Maria calling to reschedule her appointment to next Tuesday.",
      "max_turns": 8,
      "silence_threshold_ms": 1200
    }
  }
}
```

Platform-direct suite:

```json
{
  "connection": {
    "adapter": "vapi",
    "platform": { "provider": "vapi" }
  },
  "calls": {
    "happy-path": {
      "caller_prompt": "You are Maria calling to reschedule her appointment to next Tuesday.",
      "max_turns": 8
    }
  }
}
```

Write `caller_prompt` as a realistic caller with a name, goal, mood, constraints, and conditional behavior. Set `max_turns` based on flow complexity: FAQ `4-6`, booking or tool use `8-12`, complex flows `12-20`.

Call fields:

- `caller_prompt` and `max_turns` are required.
- `silence_threshold_ms` must be `200-10000`. Common ranges: FAQ `800-1200`, tool calls `2000-3000`, complex reasoning `3000-5000`.
- `persona` supports `pace`, `clarity`, `disfluencies`, `cooperation`, `emotion`, `memory`, `intent_clarity`, and `confirmation_style`.
- `caller_audio` supports noise, speed, speakerphone, mic distance, clarity, accent, packet loss, and jitter.
- `language` is an ISO 639-1 code such as `en`, `es`, `fr`, `de`, `it`, `nl`, or `ja`.
- `voice` is `"male"` or `"female"` (English only; default female). Use to flip the caller's perceived gender. Ignored if `caller_audio.accent` is set or `language` is non-English.

## Connections and Credentials

### Adapter choice

Use `websocket` for your own local or hosted runtime. Use `start_command` for local agents or `agent_url` for hosted custom endpoints. For `start_command` and `agent_url`, do not put Deepgram, ElevenLabs, OpenAI, or other agent runtime keys into Vent config unless the Vent adapter itself needs them — the tested agent owns its own runtime credentials.

Use `vapi`, `retell`, `elevenlabs`, `bland`, or `livekit` for platform-direct testing. In this mode Vent itself talks to the provider on the user's behalf.

Vent provides `DEEPGRAM_API_KEY` and `ANTHROPIC_API_KEY` for its hosted caller/evaluation stack — those are Vent's, not the tested agent's.

### Credential resolution

In platform-direct mode the CLI auto-resolves credentials from `.env.local`, `.env`, and the current shell environment. Do not run `source .env && export` before Vent commands. If you include credential fields in JSON, use the actual value, not the env var name. Do not manually author `platform_connection_id`; the CLI creates or updates the saved platform connection automatically.

Auto-resolved env vars and JSON fields:

- Vapi: `VAPI_API_KEY` -> `vapi_api_key`; `VAPI_ASSISTANT_ID` or `VAPI_AGENT_ID` -> `vapi_assistant_id`
- Bland: `BLAND_API_KEY` -> `bland_api_key`; `BLAND_PATHWAY_ID` -> `bland_pathway_id`; `BLAND_PERSONA_ID` -> `persona_id`
- LiveKit: `LIVEKIT_API_KEY` -> `livekit_api_key`; `LIVEKIT_API_SECRET` -> `livekit_api_secret`; `LIVEKIT_URL` -> `livekit_url`
- Retell: `RETELL_API_KEY` -> `retell_api_key`; `RETELL_AGENT_ID` -> `retell_agent_id`
- ElevenLabs: `ELEVENLABS_API_KEY` -> `elevenlabs_api_key`; `ELEVENLABS_AGENT_ID` -> `elevenlabs_agent_id`

### Provider config

Use existing provider config when possible: Vapi assistant, Retell agent, ElevenLabs agent, Bland pathway, or LiveKit agent. Bland uniquely supports inline config — `platform` may use `bland_pathway_id`, `persona_id`, or an inline `task` (with optional voice, model, and turn-handling overrides; see Bland's API docs for the full field list).

### Concurrency

When you fan out multiple Vent calls in parallel against the same provider (for example, running several named calls from one suite at once), respect the provider's per-account concurrency limit. Exceeding it makes calls queue or fail at the provider — Vent does not enforce these caps for you.

Record the limit as `max_concurrency` in the suite's `platform` block so it's visible on future runs. Ask the user which plan they're on if sizing matters; otherwise use the conservative default in bold.

- **Vapi**: **10** included per account; reserved lines can be purchased self-serve; Enterprise is unlimited.
- **Retell**: Pay-as-you-go includes **20**; Enterprise has no cap.
- **Bland**: Start=**10**, Build=50, Scale=100, Enterprise=unlimited.
- **ElevenLabs**: Free=**4**, Starter=6, Creator=10, Pro=20, Scale=30, Business=30. Burst pricing can temporarily allow up to 3x base.
- **LiveKit Cloud**: Build=**5**, Ship=20, Scale=50 managed inference sessions (the usual gate for voice agents); agent-session concurrency can go higher (Scale up to 600).

## WebSocket

For `adapter: "websocket"`, Vent sends binary 16-bit mono PCM audio over one websocket connection. Websocket text frames are optional JSON events. Audio-only websocket agents still work, but events improve turn detection and observability. Vent sends `{"type":"end-call"}` when the test is done.

Useful websocket text frames:

```jsonc
{"type":"speech-update","status":"started"}
{"type":"speech-update","status":"stopped"}
{"type":"tool_call","name":"check_availability","arguments":{},"result":{},"successful":true,"duration_ms":150}
{"type":"vent:timing","stt_ms":120,"llm_ms":450,"tts_ms":80}
{"type":"vent:session","platform":"custom","provider_call_id":"call_123","provider_session_id":"session_abc"}
{"type":"vent:call-metadata","call_metadata":{"recording_url":"https://...","cost_usd":0.12}}
{"type":"vent:transcript","role":"caller","text":"I need to reschedule","turn_index":0}
{"type":"vent:transfer","destination":"+15551234567","status":"attempted"}
{"type":"vent:debug-url","label":"trace","url":"https://..."}
{"type":"vent:warning","message":"provider warning","code":"provider_warning"}
```

`vent:session-report` is **not** handled by the websocket adapter — it's only consumed by the LiveKit helper. Do not emit it from a websocket agent.

Platform adapters capture tool calls automatically. Websocket agents must emit `tool_call` frames for tool observability. Platform adapters get component latency automatically. Websocket agents should emit `vent:timing` after each agent response when STT/LLM/TTS breakdown is available.

## LiveKit

Before running LiveKit tests, install and add the Vent helper to the LiveKit agent entrypoint. Node: `npm install @vent-hq/livekit`, then call `instrumentLiveKitAgent({ ctx, session })`. Python: `pip install vent-livekit`, then call `instrument_livekit_agent(ctx=ctx, session=session)`.

LiveKit direct mode requires the LiveKit Agents SDK. Custom LiveKit participants should use the websocket adapter with a relay. If the LiveKit agent registered with an explicit dispatch name, set `livekit_agent_name` in `platform`.

LiveKit parallel calls are supported, but capacity depends on where the user runs their agent. LiveKit Cloud only routes audio — the agent code runs on the user's own infrastructure (laptop, Fly.io, Railway, k8s, etc.), and that box's CPU/RAM is the real bottleneck. Before firing parallel calls, derive `platform.max_concurrency` from the minimum of: (1) the user's LiveKit plan limit (Build=5, Ship=20, Scale=50+ concurrent agent sessions), (2) their agent worker box capacity (rough rule: 1c/1GB→1–3 jobs, 2c/4GB→5–10, 4c/8GB→10–25, 8c/16GB→25–50; multiply by number of worker boxes), and (3) their STT/TTS provider concurrency (e.g. Deepgram TTS streaming = 2). If the user wants more parallel calls than that minimum allows, push back — explain which limit is the bottleneck (plan / box / provider) and either reduce the count or suggest scaling that limit. Architecture: register one `agent_name` and run N workers under it (one big worker, or several smaller ones — same name); LiveKit's dispatcher round-robins jobs across them with built-in failover. Don't use numbered names (`agent-0`, `agent-1`) — that reinvents what the dispatcher does and breaks failover.

Use the LiveKit helper for observability; do not publish `vent:*` topics manually. Do not hand-roll `vent:session-report` from `ctx.addShutdownCallback`; after `room.disconnect()` it can fail with `engine is closed`. The helper captures SDK metrics, tool events, conversation items, usage, and close events. Native LiveKit `lk.transcription` and `lk.agent.state` provide transcript and agent-state timing.

## Output

### Live result

`npx vent-hq run` returns a single JSON result on stdout in non-TTY mode (not an SSE JSONL stream). Exit codes: `0` = call ran through the pipeline; `1` = pipeline-level failure; `2` = harness error.

Most result fields are always present; `latency`, `component_latency`, `call_metadata`, and `emotion` may be `null` when the underlying analysis didn't run; `debug` is absent without `--verbose`. Branch on null before reading nested fields. Use `--verbose` only when the default doesn't explain a failure — when you need `platform_transcript` (to check Vent's STT), per-turn or component-level latency breakdowns, the raw tool-call timeline, or provider-native artifacts in `debug.provider_metadata`. Otherwise skip — it just adds noise.

Vent's transcript is ground truth. Judge on semantic intent: ignore homophones and minor mis-hears (`"check teach hat"` for `"check that"`, missing question marks on short tails) — those are streaming-STT noise on Vent's caller side, not agent bugs, and **don't surface them in the report** (they're Vent-side artifacts, not actionable for the user). But clear gibberish or word-soup (e.g. `"Cristoxin"` where the agent should have said `"Of course, talk soon"`) is **not** a Vent artifact — Vent's STT does not invent words like that. It means the platform's TTS produced corrupted audio or the agent's STT/LLM generated the wrong text, and the fix lives there (TTS voice config, agent prompt, model temperature, codec issue). Never dismiss the run as a "Vent harness STT" issue; iterate on the agent or flag the platform.

For transfers: `call_metadata.transfer_attempted` (provider claimed) and `transfer_completed` (Vent-verified) can disagree — report both. `transfers[]` carries destination, type, and per-attempt status.

### Saved history

After every run, Vent writes the full result JSON to `.vent/runs/`. Shape:

```jsonc
{
  "run_id": "...",
  "timestamp": "2026-04-21T...Z",
  "git_sha": "...",
  "summary": { "calls_total": 2, "total_duration_ms": 12345, "total_cost_usd": 0.01 },
  "call_results": [
    { "name": "happy-path", "status": "completed", "duration_ms": 6123, "transcript": [], "observed_tool_calls": [], "latency": { "response_time_ms": 420, "p95_response_time_ms": 980 }, "call_metadata": { "cost_usd": 0.004 } }
  ]
}
```

When comparing against a prior run (Workflow step 6), inspect:

- Run-completion status flips: `call_results[i].status` (pipeline-only — judge mission success from the transcript)
- Latency: `call_results[i].latency.response_time_ms` (mean) or `latency.p95_response_time_ms` increased >20%
- Tool calls: count of `call_results[i].observed_tool_calls[].successful` dropped
- Cost: `summary.total_cost_usd` or `call_results[i].call_metadata.cost_usd` increased >30%
- Transcript: `call_results[i].transcript` diverged in semantic content (ignore STT noise)

## Reporting Results

Before reporting, read the agent's code to locate where the observed behavior originates. If the issue is small and you can fix it, fix it and explain what you did — don't ask permission first.

Adapt the report shape to the call — a clean pass needs little, a regression with a multi-layer cause needs more. Use a transcript excerpt when it helps the user see what happened.

Hard rules:

- Pair raw numbers with their plain-English meaning — don't drop the number, but don't leave it unexplained. E.g. "p95 latency was 850ms, which is snappy and well within natural conversational pacing" or "p95 hit 1.6 seconds with the LLM as the bottleneck — noticeably sluggish to a caller."
- Name the user's voice agent by platform on first mention (e.g. "the Vapi agent responded snappily throughout") so the user knows immediately which agent the observation is about. After that, just say "the agent" — don't repeat the platform name on every line.
- Always include the recording from `call_metadata.recording_url` as an inline `[Recording](url)` link, placed in **one block at the very end of the report** — never sprinkled through the prose. Single call: one link as the last line. Multi-call: one labeled link per call (e.g. `reschedule-appointment: [Recording](url)`). Never paste a bare URL.
- Mission success is your judgment, not Vent's. The per-call `status` is only `"completed"` (pipeline ran) or `"error"` (pipeline failed); decide whether the agent actually accomplished the scenario from the transcript and tool calls.
- Similar-sounding word substitutions (e.g. "ocean" for "OSHA") are STT ambiguity, not comprehension failure. The fix lives in STT keyword hints, custom vocabulary, or a prompt-level term list — not the agent's reasoning.
- Surface only what the user can act on in their own agent's code or config — never `warnings[]` (infrastructure noise), Vent-side artifacts (caller wait modes, harness timing, internal pipeline quirks), or `cost_usd` unless asked.

For multi-call runs, lead with your own judgment of what happened across the calls (e.g. "3 of 4 did what they were supposed to; `cancel-appointment` never actually canceled"), not a parroted pass/fail count. Then cover each call with whatever depth it needs.
