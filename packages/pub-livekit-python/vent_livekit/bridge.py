"""Forwards LiveKit Agents SDK events to Vent over the room's data channel."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable, Dict, List, Optional, Set

from ._json import compact, field, fields, to_jsonable

logger = logging.getLogger("vent-livekit")

TOPIC_CALL_METADATA = "vent:call-metadata"
TOPIC_DEBUG_URL = "vent:debug-url"
TOPIC_WARNING = "vent:warning"
TOPIC_METRICS = "vent:metrics"
TOPIC_TOOL_CALLS = "vent:tool-calls"
TOPIC_CONVERSATION_ITEM = "vent:conversation-item"

# Chat content holding raw audio or video frames; never sent.
_BINARY_CONTENT = ("audio_content", "image_content")


class VentLiveKitBridge:
    """Returned by instrument_livekit_agent(). Publishes what only the agent
    knows; ``dispose()`` stops forwarding session events."""

    def __init__(self, ctx: Any, session: Any) -> None:
        self._session = session
        self._participant = getattr(getattr(ctx, "room", None), "local_participant", None)
        if self._participant is None:
            raise ValueError("instrument_livekit_agent needs a connected room: call it after ctx.connect().")
        self._unsubscribers: List[Callable[[], None]] = []
        # Keeps fire-and-forget publishes alive until they finish.
        self._tasks: Set[asyncio.Task] = set()

    # ── Public API ───────────────────────────────────────────────

    async def publish_call_metadata(self, metadata: Dict[str, Any]) -> None:
        """Call metadata only the agent knows, e.g. ``cost`` or ``provider_call_id``."""
        await self._publish(TOPIC_CALL_METADATA, {"call_metadata": _call_metadata(metadata)})

    async def publish_debug_url(self, label: str, url: str) -> None:
        await self._publish(TOPIC_DEBUG_URL, {"label": label, "url": url})

    async def publish_warning(self, message: str, extras: Optional[Dict[str, Any]] = None) -> None:
        await self._publish(TOPIC_WARNING, {"message": message, **(extras or {})})

    def dispose(self) -> None:
        for unsubscribe in self._unsubscribers:
            unsubscribe()
        self._unsubscribers.clear()

    # ── Session events ───────────────────────────────────────────

    def start(self) -> None:
        """Forward the session's events to Vent."""
        for event, handler in (
            ("metrics_collected", self._on_metrics),
            ("function_tools_executed", self._on_function_tools_executed),
            ("conversation_item_added", self._on_conversation_item),
            ("close", self._on_close),
        ):
            self._session.on(event, handler)
            self._unsubscribers.append(lambda e=event, h=handler: self._unsubscribe(e, h))

    def _unsubscribe(self, event: str, handler: Callable[..., None]) -> None:
        try:
            self._session.off(event, handler)
        except Exception:
            pass

    def _on_metrics(self, event: Any) -> None:
        self._publish_soon(TOPIC_METRICS, fields(event), "metrics")

    def _on_function_tools_executed(self, event: Any) -> None:
        # One vent:tool-calls message per call, matched to its output by position.
        calls = field(event, "function_calls") or []
        outputs = field(event, "function_call_outputs") or []
        for i, call in enumerate(calls):
            name = field(call, "name")
            if not name:
                continue
            output = outputs[i] if i < len(outputs) else None
            args = field(call, "arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except ValueError:
                    pass  # keep as string
            # LiveKit stamps the call when the LLM asks for it and the output when
            # the tool returns (seconds), so the gap is how long the tool ran.
            called_at, returned_at = field(call, "created_at"), field(output, "created_at")
            self._publish_soon(
                TOPIC_TOOL_CALLS,
                {
                    "type": "tool_call",
                    "name": name,
                    "arguments": args if args is not None else {},
                    "result": field(output, "output"),
                    "successful": None if output is None else not field(output, "is_error"),
                    "duration_ms": (
                        round((returned_at - called_at) * 1000)
                        if called_at is not None and returned_at is not None
                        else None
                    ),
                },
                "tool call",
            )

    def _on_conversation_item(self, event: Any) -> None:
        payload = fields(event)
        item = field(event, "item")
        if item is not None:
            content = [c for c in (field(item, "content") or []) if field(c, "type") not in _BINARY_CONTENT]
            payload["item"] = {**fields(item), "content": content}
        self._publish_soon(TOPIC_CONVERSATION_ITEM, payload, "conversation item")

    def _on_close(self, event: Any) -> None:
        # Why the session ended: participant_disconnected, user_initiated,
        # task_completed, error or job_shutdown.
        reason = field(event, "reason")
        if reason is not None:
            self._publish_soon(
                TOPIC_CALL_METADATA,
                {"call_metadata": _call_metadata({"ended_reason": str(getattr(reason, "value", reason))})},
                "close reason",
            )
        error = field(event, "error")
        if error is not None:
            self._publish_soon(
                TOPIC_WARNING, {"message": "LiveKit session closed with error", "detail": error}, "close warning"
            )

    # ── Publishing ───────────────────────────────────────────────

    async def _publish(self, topic: str, payload: Dict[str, Any]) -> None:
        message = to_jsonable({"type": topic, **payload})
        await self._participant.publish_data(json.dumps(message).encode("utf-8"), reliable=True, topic=topic)

    def _publish_soon(self, topic: str, payload: Dict[str, Any], context: str) -> None:
        """Publish from a sync event handler; a failure is logged, never raised."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            logger.warning("Not publishing %s: no running event loop", context)
            return

        async def run() -> None:
            try:
                await self._publish(topic, payload)
            except Exception as exc:
                logger.warning("Failed to publish %s: %s", context, exc)

        task = loop.create_task(run())
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)


def _call_metadata(metadata: Dict[str, Any]) -> Dict[str, Any]:
    return {**compact(metadata), "platform": "livekit"}


def instrument_livekit_agent(*, ctx: Any, session: Any) -> VentLiveKitBridge:
    """Forward a LiveKit agent's observability events to Vent.

    Args:
        ctx: LiveKit ``JobContext``. Its room carries the messages.
        session: LiveKit ``AgentSession``. Source of metrics, tool calls,
            conversation items, and close events.

    Returns:
        A :class:`VentLiveKitBridge` for publishing what only the agent knows;
        ``dispose()`` stops forwarding.
    """
    bridge = VentLiveKitBridge(ctx, session)
    bridge.start()
    return bridge
