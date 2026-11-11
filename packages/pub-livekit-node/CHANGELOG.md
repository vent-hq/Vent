# @vent-hq/livekit

## 0.5.0

### Minor Changes

- f89e049: The helper is split into modules (`bridge`, `json`, `types`) and the bridge is a class. `instrumentLiveKitAgent({ ctx, session })` now requires both, and throws if the room isn't connected yet. Removed: the `room`, `participant`, `reliable`, `sessionMetadata`, `debugUrls`, `autoPublishSessionReport` and `logger` options (pass `ctx`; delivery is always reliable; call `publishCallMetadata()` / `publishDebugUrl()` after setup), the `publishSessionUsage()` and `publishSessionReport()` methods (neither is sent anymore), `platform` on `VentCallMetadata` (always `livekit`), and `call_id` on tool calls plus the `event` field on metrics and conversation items (Vent never read them). Audio and image chat content is dropped before an event is converted to JSON, rather than after.
- f89e049: Tool calls now carry `duration_ms` (how long the tool ran, from LiveKit's call and output timestamps), and the session's close reason is sent as `ended_reason`. Vent shows both: per-tool latency and why the call ended when the agent's side ended it.
- 2d246d9: Call results are leaner and show more of what matters. `latency` is mean, p50, max and first response time. `signal_quality` shows `mean_snr_db` and `max_clipping_ratio`. `tool_calls.names` and the run-level `aggregate` are removed: they repeated other fields. Zero-cost categories are left out of the cost breakdown. Cost is one `call_metadata.cost` object: the provider's `total_usd`, plus `breakdown` in the provider's own categories when it splits the cost; `cost_usd` and `cost_breakdown` are gone. Bland cost is now Bland's reported price instead of an estimate. `provider_debug_urls` is in the default output and links to the call in the Vapi, ElevenLabs or LiveKit Cloud dashboard. In `@vent-hq/livekit`, call metadata takes `cost: { total_usd, breakdown? }` instead of `cost_usd` and `cost_breakdown`.

### Patch Changes

- f89e049: The close-with-error warning on `vent:warning` now sends the error under `detail`, which Vent reads (it was sent as `error` and dropped). The helper no longer forwards `user_input_transcribed` (Vent reads the transcript from native LiveKit transcription) or `session_usage_updated` (Vent no longer reports token usage; `cost` covers it), and no longer sends the session report on close, or `provider_metadata` and `variables` on `VentCallMetadata` (Vent no longer keeps any of them). It also no longer publishes agent-handoff transfers (the fields it checked never exist in the Agents SDK event, so it never fired). `@livekit/agents` and `@livekit/rtc-node` are no longer peer dependencies; the helper is duck-typed and imports neither. Event payloads with circular references or nesting deeper than 8 levels now publish, with those values sent as `null`; previously they failed with "Converting circular structure to JSON".

All notable changes to `@vent-hq/livekit` are documented in this file.

For the repo-wide summary, see [CHANGELOG.md](../../CHANGELOG.md).

## 0.2.0

### Notes

- Current published version.
- Detailed release notes for earlier development history were not backfilled.
