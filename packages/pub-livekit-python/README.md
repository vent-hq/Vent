# vent-livekit

Thin helper for forwarding LiveKit Agents SDK observability into Vent.

## Install

```bash
pip install vent-livekit
```

## Usage

`instrument_livekit_agent()` subscribes to LiveKit `AgentSession` events and publishes them on `vent:*` DataChannel topics that the Vent LiveKit adapter reads. Call it after `ctx.connect()` and `session.start()`.

```python
from vent_livekit import instrument_livekit_agent

vent = instrument_livekit_agent(ctx=ctx, session=session)
# On shutdown:
vent.dispose()
```

## Events forwarded

| LiveKit event              | Vent topic                      |
| -------------------------- | ------------------------------- |
| `metrics_collected`        | `vent:metrics`                  |
| `function_tools_executed`  | `vent:tool-calls` (one message per call) |
| `conversation_item_added`  | `vent:conversation-item`        |
| `close`                    | `vent:call-metadata` (`ended_reason`), `vent:warning` (on error) |

## Bridge methods

The returned bridge publishes what only the agent knows:

```python
await vent.publish_call_metadata({"cost": {"total_usd": 0.12, "breakdown": {"llm": 0.07, "tts": 0.05}}})
await vent.publish_debug_url("trace", "https://...")
await vent.publish_warning("rate limited", {"retry_after_ms": 500})
```

## Notes

- Transcript, room/session identity, and agent-state timing come from native LiveKit signals, so this helper does not mirror them.
- For the Node.js equivalent, use `@vent-hq/livekit` (`npm install @vent-hq/livekit`).
