# vent-livekit

Thin helper for forwarding LiveKit Agents SDK observability into Vent.

## Install

```bash
pip install vent-livekit
```

## Usage

`instrument_livekit_agent()` subscribes to LiveKit `AgentSession` events and publishes them on `vent:*` DataChannel topics that the Vent LiveKit adapter already understands.

```python
from vent_livekit import instrument_livekit_agent

vent = instrument_livekit_agent(ctx=ctx, session=session)
# On shutdown:
vent.dispose()
```

You can pass `room` or `participant` directly instead of `ctx`.

## Events forwarded

| LiveKit event              | Vent topic                      |
| -------------------------- | ------------------------------- |
| `metrics_collected`        | `vent:metrics`                  |
| `function_tools_executed`  | `vent:tool-calls` (one message per call), `vent:transfer` (agent handoffs) |
| `conversation_item_added`  | `vent:conversation-item`        |
| `user_input_transcribed`   | `vent:user-input-transcribed`   |
| `session_usage_updated`    | `vent:session-usage`            |
| `close`                    | `vent:session-report` (auto), `vent:warning` (on error) |

## Bridge methods

The returned bridge publishes data that the outside room observer cannot already see:

```python
await vent.publish_call_metadata({"provider_call_id": "pstn-call-123"})
await vent.publish_debug_url("insight", "https://...")
await vent.publish_warning("rate limited", {"retry_after_ms": 500})
await vent.publish_session_usage({"llm_tokens": 1200})
```

You can also pass `session_metadata` and `debug_urls` to `instrument_livekit_agent` to publish them on startup:

```python
vent = instrument_livekit_agent(
    ctx=ctx,
    session=session,
    session_metadata={"provider_call_id": "pstn-call-123"},
    debug_urls={"insight": "https://..."},
)
```

## Notes

- Transcript, room/session identity, and agent-state timing come from native LiveKit signals, so this helper does not mirror them.
- For the Node.js equivalent, use `@vent-hq/livekit` (`npm install @vent-hq/livekit`).
