# vent-hq

## 0.14.0

### Minor Changes

- 175ecc5: Use short-lived signed access tokens with automatic renewal. Required update:
  the API no longer accepts credentials saved by 0.13.2 and earlier. Sign in again
  to replace them, or set VENT_REFRESH_TOKEN to an API key.

### Patch Changes

- de3ec13: List the supported caller accents in the agent skill files; an unknown `caller_audio.accent` is now rejected instead of silently using the American voice.
- 65ee54b: Removed the `silence_threshold_ms` call option. Vent now decides when the agent has finished its turn on its own, the same way on every call, so an agent that pauses too long mid-reply shows up in the results instead of being waited out. Configs that still set it keep working; the field is ignored.
- a83c715: Show the run status and error when a run ends without a call result, and exit with code 1 instead of 0.
- 54ef1fa: `vent agent start` reports a rejected relay connection right away (with the reason) instead of appearing connected after 3 seconds.
- a83c715: The exit code now follows the run status (0 = passed, 1 = failed or cancelled). If a call result never reaches the stream, the CLI shows the stored result instead of an empty list. Call results include `end_note` when Vent ended the call or the connection closed.
- a83c715: `vent-hq stop` on a running call now reports that the call is stopping. The run ends as `cancelled` once the call hangs up.
- b4a5755: Keep waiting for a run's result when the API answers 502–504 while restarting during a deploy, instead of failing the run.
- a83c715: `vent run` resends a submit once if the connection drops or the API is restarting, with the same idempotency key, so a lost response never starts a second call.

## 0.13.2

### Patch Changes

- 6c035ab: Always connect to api.venthq.dev without an environment variable override.

  Remove the unused WebSocket dependency and inactive diagnostic logging while preserving verbose result output.

## 0.13.1

### Patch Changes

- cb976e4: Document parallel LiveKit call support in skill files. Coding agents now receive guidance on deriving `platform.max_concurrency` from the user's LiveKit plan, agent worker box capacity, and STT/TTS provider concurrency limits — rather than the previous instruction to run LiveKit calls sequentially.

## 0.13.0

### Minor Changes

- 509f70b: - **Breaking:** Removed `audio_actions` from the suite call spec (and from the result JSON's `audio_actions` field). The four action types (`interrupt`, `inject_noise`, `split_sentence`, `noise_on_caller`) tested platform configuration knobs (barge-in thresholds, noise filtering, endpointing) rather than agent code, so the metrics weren't actionable. Use `caller_audio.noise` for global noisy-line tests, and shape pacing via `caller_prompt`.
  - **Breaking:** Removed `persona.interruption_style`. The autonomous mid-turn interruption planner that powered it has been removed too — caller behavior is now driven entirely by the system prompt + `caller_prompt`.
  - Added `packages/cli/README.md` for the npm landing page (install, quickstart, sample suite, JSON output shape, per-platform notes).
  - Refreshed Claude Code / Cursor / Codex skill files: dropped all `audio_actions` and `interruption_style` references and examples.
  - Caller system prompt: tightened `wait` mode (now restricted to mid-utterance / tool calls / explicit "one moment") and added a goal-focus rule so the caller stops inventing stall tactics like "let me check with my team" once its objective is reachable or unreachable.

## 0.12.1

### Patch Changes

- 4936379: - Ctrl+C / SIGTERM now fires `POST /runs/:id/stop` and waits for it before exiting; the worker actually hangs up the platform call.
  - `init` flow rewritten: GitHub auto-auth via `gh` token, browser sign-in (WorkOS device flow) fallback. Anonymous bootstrap removed.
  - Run summary JSON now exposes top-level `status`, `passed`, `failed` so coding agents don't have to recompute from `calls[]`.
  - Skill files updated: corrected JSON field names (was `metrics.latency_p50_ms`, now `latency.response_time_ms`), tighter transcript/STT guidance, brief-by-default reporting rule.
  - CLI source typecheck fixes (resolvedRemotePlatform, RunSummaryJsonOptions, sse.ts ReadableStreamReadResult, auth.ts JSON typing).
  - `@vent/relay-client` ships hand-written `.d.ts` so consumers compile cleanly without the source's browser-globals.

## 0.10.1

### Patch Changes

- 5a02a64: Warn coding agents not to hand-roll `vent:session-report` for LiveKit agents. The skill files now flag that seeing the event in the WebSocket-mode examples does not authorize publishing it manually from a LiveKit agent — `ctx.addShutdownCallback` runs after `room.disconnect()` and the publish fails with "engine is closed". In LiveKit mode only publish what the helper explicitly supports.

## 0.9.19

### Patch Changes

- Auto-approve vent-hq Bash commands in .claude/settings.json to enable parallel execution

## 0.9.18

### Patch Changes

- Fix parallel execution: use single shell command with & instead of separate tool calls

## 0.9.17

### Patch Changes

- Move parallel execution to Critical Rules so coding agents never run calls sequentially

## 0.9.16

### Patch Changes

- Instruct coding agents to run multiple calls in parallel instead of sequentially

All notable changes to `vent-hq` are documented in this file.

For the repo-wide summary, see [CHANGELOG.md](../../CHANGELOG.md).

## 0.9.15

### Fixed

- Ensured npm publishes a freshly built CLI bundle by running `clean` and `build` during `prepack`.

### Changed

- Added canonical changelog metadata for the published `vent-hq` package.

## 0.9.14

### Notes

- Current published version.
- Detailed notes for releases between `0.8.29` and `0.9.14` were not backfilled.

## 0.8.29

### Changed

- Version-only CLI release.

## 0.8.0

### Added

- Inlined the full config schema into the Claude Code, Cursor, and Codex skill files so agents no longer need `npx vent-hq docs`.
- Auto-assigned free ports for local agents started with `start_command` to avoid collisions in parallel runs.
- Added formatted test results to SSE events, including `passed_tests` and `failed_tests`.

### Changed

- Removed the `docs` command now that the schema ships with the skill files.
- Routed debug logs to stderr so stdout stays clean for structured output.

### Fixed

- Emitted SSE events as JSON lines in non-TTY mode so coding agents no longer see empty or `undefined` output.
- Suppressed info and progress stderr output in non-TTY mode unless `--verbose` is set, keeping the final JSON summary clean for coding agents.
- Removed `.vent/last-run.log` and its shell workaround now that stdout is reliable.
- Added validation to ensure `run_id` exists after submit.
