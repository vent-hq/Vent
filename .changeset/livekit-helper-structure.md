---
"@vent-hq/livekit": minor
---

The helper is split into modules (`bridge`, `json`, `types`) and the bridge is a class. `instrumentLiveKitAgent({ ctx, session })` now requires both, and throws if the room isn't connected yet. Removed: the `room`, `participant`, `reliable`, `sessionMetadata`, `debugUrls`, `autoPublishSessionReport` and `logger` options (pass `ctx`; delivery is always reliable; call `publishCallMetadata()` / `publishDebugUrl()` after setup), the `publishSessionUsage()` and `publishSessionReport()` methods (neither is sent anymore), `platform` on `VentCallMetadata` (always `livekit`), and `call_id` on tool calls plus the `event` field on metrics and conversation items (Vent never read them). Audio and image chat content is dropped before an event is converted to JSON, rather than after.
