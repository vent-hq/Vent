# vent-livekit

All notable changes to `vent-livekit` are documented in this file.

For the repo-wide summary, see [CHANGELOG.md](../../CHANGELOG.md).

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
