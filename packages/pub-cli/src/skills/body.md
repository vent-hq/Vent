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

{{EXECUTION}}

## Workflow

1. Identify the behavior under test. Read enough of the agent codebase to understand its system prompt, tools, handlers, routes, provider config, platform wiring, and expected handoffs.
2. Reuse an existing `.vent/suite.<adapter>.json` when possible. If `.vent/` contains multiple suites, inspect `connection.adapter` and report which suite file produced the result.
3. Create or update a suite only when the existing calls do not cover the changed behavior. Name calls after real flows, for example `reschedule-appointment`, not `call-1`.
4. If the suite uses `start_command`, start one shared local session first with `npx vent-hq agent start -f .vent/suite.<adapter>.json`, then pass `--session <session-id>` to each run.

   **For locally-run LiveKit agents: every run requires killing *all* workers, starting one fresh worker, and waiting a full 60 seconds before submitting.** Unconditional — LiveKit Cloud round-robins across registered workers, so a single survivor with a dead inference subprocess fails ~N-1 of N calls. Don't rely on `pkill -f <path-pattern>`; bare command lines like `node --import tsx agent.ts dev` won't match a path filter. Use `ps aux | grep -E "node.*agent\.ts|@livekit/agents.*ipc"`, `kill -9` by PID, re-run `ps` to confirm zero survivors, then start the fresh worker. Skipping the 60s wait fails with `did not publish audio track`; if that error appears alongside `Error [ERR_IPC_CHANNEL_CLOSED] from InferenceProcExecutor.doInference` in the agent log right after a "running EOU detection" line, that's a straggler — redo the kill sweep. Hosted LiveKit Cloud agents don't need any of this; run normally.{{LIVEKIT_NOTE}}
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
npx vent-hq stop <run-id>                         # Cancel a queued or running run
npx vent-hq agent start -f .vent/suite.X.json     # Start a shared local relay session
npx vent-hq agent stop <session-id>               # Stop a shared local relay session
```

If `~/.vent/credentials` is missing and neither `VENT_REFRESH_TOKEN` nor `VENT_ACCESS_TOKEN` is set, run `npx vent-hq init`. After `init` signs the user in, tell them in your first reply that their Vent access token is saved in `~/.vent/credentials` on their machine. For an existing account, run `npx vent-hq login` or set `VENT_REFRESH_TOKEN` to an API key. Access JWTs renew automatically; `VENT_ACCESS_TOKEN` alone is short-lived.

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
      "max_turns": 8
    }
  }
}
```

Platform-direct suite:

```json
{
  "connection": {
    "adapter": "vapi"
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

- `caller_prompt` is required. `max_turns` defaults to `6`.
- `persona` supports `pace`, `clarity`, `disfluencies`, `cooperation`, `emotion`, `memory`, `intent_clarity`, and `confirmation_style`.
- `caller_audio` supports noise, speed, speakerphone, mic distance, clarity, accent, packet loss, and jitter.
- `caller_audio.accent` picks the caller's voice. Supported: `american` (default), `british`, `australian`, `filipino`, `spanish_mexican`, `spanish_peninsular`, `spanish_colombian`, `spanish_argentine`, `german`, `french`, `italian`, `dutch`, `japanese`. Any other value is rejected. The non-English accents are voices in that language: also set `language` (e.g. `"es"`) so the caller speaks it.
- `language` is an ISO 639-1 code such as `en`, `es`, `fr`, `de`, `it`, `nl`, or `ja`.
- `voice` is `"male"` or `"female"` (English only; default female). Use to flip the caller's perceived gender. Ignored if `caller_audio.accent` is set or `language` is non-English.

## Connections and Credentials

### Adapter choice

Use `websocket` for your own local or hosted runtime. Use `start_command` for local agents or `agent_url` for hosted custom endpoints. For `start_command` and `agent_url`, do not put Deepgram, ElevenLabs, OpenAI, or other agent runtime keys into Vent config unless the Vent adapter itself needs them — the tested agent owns its own runtime credentials.

Use `vapi`, `retell`, `elevenlabs`, `bland`, or `livekit` for platform-direct testing. In this mode Vent itself talks to the provider on the user's behalf.

Vent provides `DEEPGRAM_API_KEY` and `ANTHROPIC_API_KEY` for its hosted caller/evaluation stack — those are Vent's, not the tested agent's.

### Credential resolution

In platform-direct mode the CLI auto-resolves credentials from `.env.local`, `.env`, and the current shell environment. If the project uses a secrets manager like Doppler, wrap the command so the secrets are set: `doppler run -- npx vent-hq run -f <suite.json>`. Do not run `source .env && export` before Vent commands. Keep credentials out of chat and suite files; the CLI sends the resolved configuration to Vent, which stores an encrypted copy with each run.

Auto-resolved env vars and JSON fields:

- Vapi: `VAPI_API_KEY` -> `vapi_api_key`; `VAPI_ASSISTANT_ID` or `VAPI_AGENT_ID` -> `vapi_assistant_id`
- Bland: `BLAND_API_KEY` -> `bland_api_key`; `BLAND_PATHWAY_ID` -> `bland_pathway_id`; `BLAND_PERSONA_ID` -> `persona_id`
- LiveKit: `LIVEKIT_API_KEY` -> `livekit_api_key`; `LIVEKIT_API_SECRET` -> `livekit_api_secret`; `LIVEKIT_URL` -> `livekit_url`
- Retell: `RETELL_API_KEY` -> `retell_api_key`; `RETELL_AGENT_ID` -> `retell_agent_id`
- ElevenLabs: `ELEVENLABS_API_KEY` -> `elevenlabs_api_key`; `ELEVENLABS_AGENT_ID` -> `elevenlabs_agent_id`

### Provider config

Use existing provider config when possible: Vapi assistant, Retell agent, ElevenLabs agent, Bland pathway, or LiveKit agent. Bland uniquely supports inline config — `platform` needs `bland_pathway_id` or an inline `task`, optionally with `persona_id` and voice, model, and turn-handling overrides (see Bland's API docs for the full field list).

### Concurrency

If the repo has voice agents on more than one platform (e.g. one on Retell and one on Vapi), test one platform at a time: wait for one platform's batch of calls to return before starting the next platform's. Parallel calls are fine, but only to one platform at once.

When you fan out multiple Vent calls in parallel against the same provider (for example, running several named calls from one suite at once{{PARALLEL_EXAMPLE}}), respect the provider's per-account concurrency limit. Exceeding it makes calls queue or fail at the provider — Vent does not enforce these caps for you.

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
{"type":"vent:call-metadata","call_metadata":{"recording_url":"https://...","cost":{"total_usd":0.12,"breakdown":{"llm":0.07,"tts":0.05}}}}
{"type":"vent:transcript","role":"caller","text":"I need to reschedule"}
{"type":"vent:transcript","role":"agent","text":"Sure, which day works for you?"}
{"type":"vent:transfer","destination":"+15551234567","status":"attempted"}
{"type":"vent:debug-url","label":"trace","url":"https://..."}
{"type":"vent:warning","message":"provider warning","code":"provider_warning"}
```

Platform adapters capture tool calls automatically. Websocket agents must emit `tool_call` frames for tool observability. Platform adapters get component latency automatically. Websocket agents should emit `vent:timing` after each agent response when STT/LLM/TTS breakdown is available.

## LiveKit

Before running LiveKit tests, install and add the Vent helper to the LiveKit agent entrypoint. Node: `npm install @vent-hq/livekit`, then call `instrumentLiveKitAgent({ ctx, session })`. Python: `pip install vent-livekit`, then call `instrument_livekit_agent(ctx=ctx, session=session)`.

LiveKit direct mode requires the LiveKit Agents SDK. Custom LiveKit participants should use the websocket adapter with a relay. If the LiveKit agent registered with an explicit dispatch name, set `livekit_agent_name` in `platform`.

LiveKit parallel calls are supported, but capacity depends on where the user runs their agent. LiveKit Cloud only routes audio — the agent code runs on the user's own infrastructure (laptop, Fly.io, Railway, k8s, etc.), and that box's CPU/RAM is the real bottleneck. Before firing parallel calls, derive `platform.max_concurrency` from the minimum of: (1) the user's LiveKit plan limit (Build=5, Ship=20, Scale=50+ concurrent agent sessions), (2) their agent worker box capacity (rough rule: 1c/1GB→1–3 jobs, 2c/4GB→5–10, 4c/8GB→10–25, 8c/16GB→25–50; multiply by number of worker boxes), and (3) their STT/TTS provider concurrency (e.g. Deepgram TTS streaming = 2). If the user wants more parallel calls than that minimum allows, push back — explain which limit is the bottleneck (plan / box / provider) and either reduce the count or suggest scaling that limit. Architecture: register one `agent_name` and run N workers under it (one big worker, or several smaller ones — same name); LiveKit's dispatcher round-robins jobs across them with built-in failover. Don't use numbered names (`agent-0`, `agent-1`) — that reinvents what the dispatcher does and breaks failover.

Use the LiveKit helper for observability; do not publish `vent:*` topics manually. The helper captures SDK metrics, tool events, conversation items, and close events. Native LiveKit `lk.transcription` and `lk.agent.state` provide transcript and agent-state timing.

## Output

### Live result

`npx vent-hq run` returns a single JSON result on stdout in non-TTY mode (not an SSE JSONL stream). As soon as the run exists, it prints `Run created: <id>` and the matching stop command on stderr. If a run is interrupted before its result comes back, `npx vent-hq stop <id>` stops it, or says it already ended. Exit codes: `0` = the run passed (every call ran end to end); `1` = it didn't (a call errored, or the run failed or was cancelled); `2` = the result stream was lost. A call `error` starting with `Vent failed, agent not tested:` is a failure of Vent itself (its caller LLM, STT/TTS or worker): rerun, it says nothing about the agent. Any other `error` comes from the agent's platform or your configuration. `end_note` says how a completed call ended when Vent ended it or the connection closed (e.g. `No agent speech for 30s after the caller's turn; Vent hung up.`): read the transcript to judge whether that's an agent bug.

Most result fields are always present; `latency`, `component_latency`, `signal_quality`, and `call_metadata` may be `null` when the underlying analysis didn't run; `warnings` is absent when there are none. Branch on null before reading nested fields. Each agent turn carries `tool_calls`: the tools it ran for that reply, with arguments, result, `successful` and `latency_ms`, so you can check what the agent said against what its tools returned. A tool the agent ran but never replied after is on the call's last turn. A call-level `tool_calls` list appears only for a failed call whose transcript was lost. Tool results are complete, never shortened. `component_latency` is the mean time of each stage of the agent's pipeline across the call (`mean_stt_ms`, `mean_llm_ms`, `mean_tts_ms`), as the platform reports it, so a slow stage stands out. For anything deeper, open the links in `call_metadata.provider_debug_urls`.

Vent's transcript is ground truth. Judge on semantic intent: ignore homophones and minor mis-hears (`"check teach hat"` for `"check that"`, missing question marks on short tails) — those are streaming-STT noise on Vent's caller side, not agent bugs, and **don't surface them in the report** (they're Vent-side artifacts, not actionable for the user). But clear gibberish or word-soup (e.g. `"Cristoxin"` where the agent should have said `"Of course, talk soon"`) is **not** a Vent artifact — Vent's STT does not invent words like that. It means the platform's TTS produced corrupted audio or the agent's STT/LLM generated the wrong text, and the fix lives there (TTS voice config, agent prompt, model temperature, codec issue). Missing or cut-off agent text, unlike word-soup, can come from Vent's STT stream dropping: check the recording before blaming the agent.

There are two transcripts. `transcript` is Vent's record: caller turns are exactly what Vent's caller said, agent turns are what Vent heard the agent say. `platform_transcript` is the agent platform's own record (`null` when the platform gives none): agent turns are everything the agent was set to say (its LLM's text plus fixed messages like the greeting or a tool's "one moment"), caller turns are what the agent's speech-to-text heard. On Retell and LiveKit, an agent turn the caller interrupted shows only what was spoken before the cut, since those platforms keep nothing else; on the others it shows the full text. Vapi never reports the text of its tool wait messages ("Just a sec"), so those are missing from Vapi's agent turns. Compare them turn by turn:
- Agent wrote it right but Vent heard it differently on a number, ID, date or name (e.g. LLM wrote `555-0102`, Vent heard "five five five one two"): the agent's voice read it wrong. Fix how that text reaches the TTS (normalization, spelling or pronunciation tags), not the prompt's logic. If the agent's LLM text is already wrong, the fix is in the LLM, prompt or tool data.
- Vent's caller said it right but the agent's STT heard something else (e.g. "OSHA" heard as "ocean"): the agent misheard. Fix the agent's STT (keyword hints, custom vocabulary).

`latency` covers agent replies: `response_time_ms` (mean), `p50_response_time_ms`, `max_response_time_ms` (the slowest reply), and `first_response_time_ms`. `signal_quality` is the agent's raw audio: `mean_snr_db` (>20 good, <10 bad) and `max_clipping_ratio` (>0.01 = distortion). Bad values point at the agent's TTS or audio pipeline. `call_metadata.cost` is what the provider charged: `total_usd`, plus `breakdown` in the provider's own categories when the provider splits it (Bland and some agents report only the total). `call_metadata.provider_debug_urls` links to the call in the provider's dashboard or logs.

For transfers: `call_metadata.transfer_attempted` (provider claimed) and `transfer_completed` (from the platform's call data) can disagree — report both. `transfers[]` carries destination, type, and per-attempt status.

### Saved history

After every run, the CLI saves the call result to `.vent/runs/`. Shape:

```jsonc
{
  "run_id": "...",
  "timestamp": "2026-04-21T...Z",
  "git_sha": "...",
  "summary": { "status": "pass", "calls_total": 1, "total_duration_ms": 12345 },
  "call_results": [
    { "name": "happy-path", "status": "completed", "duration_ms": 6123, "transcript": [], "latency": { "response_time_ms": 420, "max_response_time_ms": 980 }, "call_metadata": { "cost": { "total_usd": 0.004 } } }
  ]
}
```

When comparing against a prior run (Workflow step 6), inspect:

- Run-completion status flips: `call_results[i].status` (pipeline-only — judge mission success from the transcript)
- Latency: `call_results[i].latency.response_time_ms` (mean) or `latency.max_response_time_ms` increased >20%
- Tool calls: a tool that succeeded before now fails (`successful: false`), or is no longer called, in the agent turns' `tool_calls`
- Cost: `call_results[i].call_metadata.cost.total_usd` increased >30% (`cost.breakdown` shows which part grew)
- Transcript: `call_results[i].transcript` diverged in semantic content (ignore STT noise)

## Reporting Results

Before reporting, read the agent's code to locate where the observed behavior originates. If the issue is small and you can fix it, fix it and explain what you did — don't ask permission first.

Adapt the report shape to the call — a clean pass needs little, a regression with a multi-layer cause needs more. Use a transcript excerpt when it helps the user see what happened.

Hard rules:

- Pair raw numbers with their plain-English meaning — don't drop the number, but don't leave it unexplained. E.g. "the slowest reply took 850ms, which is snappy and well within natural conversational pacing" or "the slowest reply hit 1.6 seconds with the LLM as the bottleneck — noticeably sluggish to a caller."
- Name the user's voice agent by platform on first mention (e.g. "the Vapi agent responded snappily throughout") so the user knows immediately which agent the observation is about. After that, just say "the agent" — don't repeat the platform name on every line.
- Always include the recording from `call_metadata.recording_url` as an inline `[Recording](url)` link, placed in **one block at the very end of the report** — never sprinkled through the prose. Single call: one link as the last line. Multi-call: one labeled link per call (e.g. `reschedule-appointment: [Recording](url)`). Never paste a bare URL.
- Mission success is your judgment, not Vent's. The per-call `status` is only `"completed"` (pipeline ran) or `"error"` (pipeline failed); decide whether the agent actually accomplished the scenario from the transcript and tool calls.
- Similar-sounding word substitutions (e.g. "ocean" for "OSHA") are STT ambiguity, not comprehension failure. The fix lives in STT keyword hints, custom vocabulary, or a prompt-level term list — not the agent's reasoning.
- Surface only what the user can act on in their own agent's code or config — never Vent-side artifacts (caller wait modes, harness timing, internal pipeline quirks), or cost unless asked.

For multi-call runs, lead with your own judgment of what happened across the calls (e.g. "3 of 4 did what they were supposed to; `cancel-appointment` never actually canceled"), not a parroted pass/fail count. Then cover each call with whatever depth it needs.
