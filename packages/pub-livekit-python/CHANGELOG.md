# vent-livekit

All notable changes to `vent-livekit` are documented in this file.

For the repo-wide summary, see [CHANGELOG.md](../../CHANGELOG.md).

## 0.5.0

### Added

- Tool calls carry `duration_ms`: how long the tool ran, from LiveKit's call and output timestamps.
- The session's close reason is sent as `ended_reason` on `vent:call-metadata`, so Vent shows why the call ended when the agent's side ended it.

### Fixed

- Tool calls published on `vent:tool-calls` now carry `type: "tool_call"`. Previously they were sent with `type: "vent:tool-calls"`, so Vent dropped every tool call from LiveKit agents using the Python helper.
- The close-with-error warning on `vent:warning` now sends the error under `detail`, which Vent reads (it was sent as `error` and dropped).
- Event payloads with circular references or nesting deeper than 8 levels no longer fail to serialize: those values are sent as `null`. Previously the depth limit passed the raw object through, so a deep or circular payload could not be published.

### Changed

- The helper is split into modules (`bridge.py`, `_json.py`) and `VentLiveKitBridge` is a regular class. The package moved out of `src/`; the import is still `from vent_livekit import instrument_livekit_agent`. The `VENT_TOPICS` dict is no longer exported.
- `instrument_livekit_agent(ctx=..., session=...)` now requires both, and raises if the room isn't connected yet.
- `platform` in call metadata is always `livekit`.
- `session_usage_updated` is no longer forwarded on `vent:session-usage`: Vent no longer reports token usage.
- The session report is no longer sent on `vent:session-report` when the session closes: Vent no longer keeps it.
- Audio and image chat content is dropped before an event is converted to JSON, rather than after.
- A publish attempted with no running event loop is logged instead of dropped silently, and in-flight publishes are kept alive until they finish.
- A session that closes with an exception sends its type and message in the warning's `detail` (previously an empty object).

### Removed

- The `room`, `participant`, `reliable`, `session_metadata`, `debug_urls` and `auto_publish_session_report` options. Pass `ctx`; delivery is always reliable; call `publish_call_metadata()` / `publish_debug_url()` after setup.
- `publish_session_usage()` and `publish_session_report()`. Neither is sent anymore.
- `call_id` on tool calls and the `event` field on metrics and conversation items. Vent never read them.
- Stop forwarding `user_input_transcribed` on `vent:user-input-transcribed`. Vent reads the transcript from native LiveKit transcription, so the topic was ignored.
- Remove the agent-handoff `vent:transfer` publish. It keyed off `has_agent_handoff`/`new_agent_id`, which never appear in the serialized event, so it never fired.

## 0.4.0

### Added

- Auto-publish a session report on `vent:session-report` when the LiveKit `AgentSession` closes. The helper subscribes to `session.on("close")`, which fires **before** `room.disconnect()` — previously, publishing from `ctx.add_shutdown_callback()` ran after the transport was torn down and raised "engine is closed". By default the helper calls `ctx.make_session_report(session)` (requires `livekit-agents>=1.0`) and publishes the result. Disable with `auto_publish_session_report=False`.
- New `bridge.publish_session_report(report=None)` method for callers who want to publish a custom report (e.g. before driving an explicit shutdown).

## 0.3.0

### Changed

- Collapse `vent:function-tools-executed` into `vent:tool-calls`. The helper now normalizes the LiveKit `function_tools_executed` session event into **per-call** `{type:"tool_call", name, arguments, result, successful, call_id}` messages and publishes them on `vent:tool-calls` — the same canonical shape WebSocket agents use. Agent handoffs (`has_agent_handoff`) are published separately on `vent:transfer`.

### Breaking

- Subscribers to `vent:function-tools-executed` must subscribe to `vent:tool-calls` (and optionally `vent:transfer`) instead.

## 0.2.0

### Notes

- Current published version.
- Detailed release notes for earlier development history were not backfilled.
