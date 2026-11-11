---
"@vent-hq/livekit": patch
---

The close-with-error warning on `vent:warning` now sends the error under `detail`, which Vent reads (it was sent as `error` and dropped). The helper no longer forwards `user_input_transcribed` (Vent reads the transcript from native LiveKit transcription) or `session_usage_updated` (Vent no longer reports token usage; `cost` covers it), and no longer sends the session report on close, or `provider_metadata` and `variables` on `VentCallMetadata` (Vent no longer keeps any of them). It also no longer publishes agent-handoff transfers (the fields it checked never exist in the Agents SDK event, so it never fired). `@livekit/agents` and `@livekit/rtc-node` are no longer peer dependencies; the helper is duck-typed and imports neither. Event payloads with circular references or nesting deeper than 8 levels now publish, with those values sent as `null`; previously they failed with "Converting circular structure to JSON".
