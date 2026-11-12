# Vent - Voice Agent Calls

## When to Run

Run Vent in one of two ways, depending on what the user wants:

- **One-off call.** After a major change to the voice agent (a prompt rewrite, a tool or handler change, routing or transfer logic, provider or audio config), place a call to test that change.
- **Loop until it works.** When the user wants a fully working voice agent, for example one built from zero, keep calling and fixing (a Ralph loop) until it does everything it should.

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

1. Reuse an existing `.vent/suite.<adapter>.json` when possible. If `.vent/` contains multiple suites, inspect `connection.adapter` and report which suite file produced the result.
2. If there's no suite for the agent's platform yet, create `.vent/suite.<adapter>.json` before the first call (see Suite Config); otherwise update a suite only when its calls don't cover what you're testing. Name calls after real flows, for example `reschedule-appointment`, not `call-1`.
3. If the suite uses `start_command`, start one shared local session first with `npx vent-hq agent start -f .vent/suite.<adapter>.json`, then pass `--session <session-id>` to each run.

   **For locally-run LiveKit agents, restart cleanly before every run:** kill *all* agent workers by PID (`pkill -f` with a path pattern misses bare `node agent.ts dev` processes), confirm none are left, start one fresh worker, and wait a full 60 seconds before submitting. LiveKit Cloud round-robins across registered workers, so one stale worker with a dead inference subprocess fails most calls. Submitting too early fails with `did not publish audio track`; `ERR_IPC_CHANNEL_CLOSED` from `InferenceProcExecutor` in the agent log means a stale worker survived. Hosted LiveKit Cloud agents don't need any of this.{{LIVEKIT_NOTE}}
4. Earlier results are saved in `.vent/runs/` (see Saved history). Compare against them when checking a fix or a regression.

## Commands

```bash
npx vent-hq init                                  # First-time setup (auth + skill install)
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

Run `npx vent-hq run` on its own: a shell command that runs it contains only `npx vent-hq run` calls. Chaining several with `&` and `wait` to run calls in parallel is fine. Anything else (`cat`, `jq`, `grep`, starting or restarting an agent, waiting) goes in a separate command before or after, never in the same one and never piped into or out of Vent. The one exception is a secrets wrapper, like `doppler run -- npx vent-hq run …`.

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

Call fields:

- `caller_prompt` is required: who the caller is and what they want. `max_turns` caps the caller's turns (default `6`); booking or tool flows usually need `8-12`.
- `persona` supports `pace`, `clarity`, `disfluencies`, `cooperation`, `emotion`, `memory`, `intent_clarity`, and `confirmation_style`.
- `caller_audio` supports noise, speed, speakerphone, mic distance, clarity, accent, packet loss, and jitter.
- `caller_audio.accent` picks the caller's voice. Supported: `american` (default), `british`, `australian`, `filipino`, `spanish_mexican`, `spanish_peninsular`, `spanish_colombian`, `spanish_argentine`, `german`, `french`, `italian`, `dutch`, `japanese`. Any other value is rejected. The non-English accents are voices in that language: also set `language` (e.g. `"es"`) so the caller speaks it.
- `language` is an ISO 639-1 code such as `en`, `es`, `fr`, `de`, `it`, `nl`, or `ja`.
- `voice` is `"male"` or `"female"` (English only; default female). Use to flip the caller's perceived gender. Ignored if `caller_audio.accent` is set or `language` is non-English.

## Connections and Credentials

### Adapter choice

Use `websocket` for your own local or hosted runtime. Use `start_command` for local agents or `agent_url` for hosted custom endpoints. For `start_command` and `agent_url`, do not put Deepgram, ElevenLabs, OpenAI, or other agent runtime keys into Vent config unless the Vent adapter itself needs them — the tested agent owns its own runtime credentials.

Use `vapi`, `retell`, `elevenlabs`, `bland`, or `livekit` for platform-direct testing. In this mode Vent itself talks to the provider on the user's behalf.

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

Parallel calls to one provider (for example, several named calls from one suite at once{{PARALLEL_EXAMPLE}}) count against that provider's per-account concurrency limit. Going over makes calls queue or fail at the provider; Vent doesn't enforce the limit. Before running 5 or more calls at once, find out which plan the tested agent's platform account is on (from the project or the platform's dashboard or API if you can, otherwise ask the user) and stay within that plan's limit. Until you know the plan, stay within the lowest limit (in bold):

- **Vapi**: **10** included per account; reserved lines can be purchased self-serve; Enterprise is unlimited.
- **Retell**: Pay-as-you-go includes **20**; Enterprise has no cap.
- **Bland**: Start=**10**, Build=50, Scale=100, Enterprise=unlimited.
- **ElevenLabs**: Free=**4**, Starter=6, Creator=10, Pro=20, Scale=30, Business=30. Burst pricing can temporarily allow up to 3x base.
- **LiveKit Cloud**: Build=**5**, Ship=20, Scale=50 managed inference sessions. The user's own agent workers (they run on the user's machines) and their STT/TTS provider can be tighter limits than the plan.

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

Use the LiveKit helper for observability; do not publish `vent:*` topics manually. The helper captures SDK metrics, tool events, conversation items, and close events. Native LiveKit `lk.transcription` and `lk.agent.state` provide transcript and agent-state timing.

## Output

### Live result

`npx vent-hq run` returns a single JSON result on stdout in non-TTY mode (not an SSE JSONL stream). As soon as the run exists, it prints `Run created: <id>` and the matching stop command on stderr. If a run is interrupted before its result comes back, `npx vent-hq stop <id>` stops it, or says it already ended. Exit codes: `0` = the run passed (every call ran end to end); `1` = it didn't (a call errored, or the run failed or was cancelled); `2` = the result stream was lost. A call `error` starting with `Vent failed, agent not tested:` is a failure of Vent itself (its caller LLM, STT/TTS or worker): rerun, it says nothing about the agent. Any other `error` comes from the agent's platform or your configuration. `end_note` says how a completed call ended when Vent ended it or the connection closed (e.g. `No agent speech for 30s after the caller's turn; Vent hung up.`): read the transcript to judge whether that's an agent bug.

Most result fields are always present; `latency`, `component_latency`, `signal_quality`, and `call_metadata` may be `null` when the underlying analysis didn't run; `warnings` is absent when there are none. Each agent turn carries `tool_calls`: the tools it ran for that reply, with arguments, result, `successful` and `latency_ms`, so you can check what the agent said against what its tools returned. A tool the agent ran but never replied after is on the call's last turn. A call-level `tool_calls` list appears only for a failed call whose transcript was lost. Tool results are complete, never shortened. `component_latency` is the mean time of each stage of the agent's pipeline across the call (`mean_stt_ms`, `mean_llm_ms`, `mean_tts_ms`), as the platform reports it, so a slow stage stands out. For anything deeper, open the links in `call_metadata.provider_debug_urls`.

Vent's transcript is ground truth for what the caller heard. Vent's own speech-to-text adds small noise, like homophones and minor mis-hears (`"check teach hat"` for `"check that"`): not an agent bug, and nothing the user can fix. Gibberish is different: `"Cristoxin"` where the agent should have said `"Of course, talk soon"` came from the agent's TTS, STT or LLM, not from Vent. Missing or cut-off agent text can be Vent's stream dropping, so check the recording before blaming the agent.

There are two transcripts. `transcript` is Vent's record: caller turns are exactly what Vent's caller said, agent turns are what Vent heard the agent say. `platform_transcript` is the agent platform's own record (`null` when the platform gives none): agent turns are everything the agent was set to say (its LLM's text plus fixed messages like the greeting or a tool's "one moment"), caller turns are what the agent's speech-to-text heard. On Retell and LiveKit, an agent turn the caller interrupted shows only what was spoken before the cut, since those platforms keep nothing else; on the others it shows the full text. Vapi never reports the text of its tool wait messages ("Just a sec"), so those are missing from Vapi's agent turns. Compare them turn by turn:
- The agent's text is right but Vent heard a number, ID, date or name differently (LLM wrote `555-0102`, Vent heard "five five five one two"): the agent's TTS read it wrong.
- Vent's caller said it right but the agent's STT heard something else ("OSHA" heard as "ocean"): the agent misheard.

`latency` covers agent replies: `response_time_ms` (mean), `p50_response_time_ms`, `max_response_time_ms` (the slowest reply), and `first_response_time_ms`. `signal_quality` is the agent's raw audio: `mean_snr_db` (>20 good, <10 bad) and `max_clipping_ratio` (>0.01 = distortion). Bad values point at the agent's TTS or audio pipeline. `call_metadata.cost` is what the provider charged: `total_usd`, plus `breakdown` in the provider's own categories when the provider splits it (Bland and some agents report only the total). `call_metadata.provider_debug_urls` links to the call in the provider's dashboard or logs.

For transfers: `call_metadata.transfer_attempted` (provider claimed) and `transfer_completed` (from the platform's call data) can disagree. `transfers[]` carries destination, type, and per-attempt status.

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

`git_sha` ties each saved run to the code it ran against.

## Reporting Results

Before reporting, read the agent's code to locate where the observed behavior originates. If the issue is small and you can fix it, fix it and explain what you did — don't ask permission first.

The per-call `status` only says whether the call ran (`"completed"`) or the pipeline failed (`"error"`). Whether the agent actually did what the scenario needed is your judgment, from the transcript and tool calls. Leave out Vent-side artifacts (its caller's STT noise, harness timing); the user can't act on them. End the report with each call's recording from `call_metadata.recording_url` as an inline `[Recording](url)` link, labeled by call name when there are several.
