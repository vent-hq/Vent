/** Forwards LiveKit Agents SDK events to Vent over the room's data channel. */

import { compact, field, fields, toJsonable } from "./json.js";
import type {
  EventHandler,
  LiveKitEventEmitterLike,
  LiveKitJobContextLike,
  LiveKitLocalParticipantLike,
  LiveKitSessionLike,
  VentCallMetadata,
  VentLiveKitBridge,
} from "./types.js";

const TOPICS = {
  callMetadata: "vent:call-metadata",
  debugUrl: "vent:debug-url",
  warning: "vent:warning",
  metrics: "vent:metrics",
  toolCalls: "vent:tool-calls",
  conversationItem: "vent:conversation-item",
} as const;

type Topic = (typeof TOPICS)[keyof typeof TOPICS];

/** Chat content holding raw audio or video frames; never sent. */
const BINARY_CONTENT = new Set(["audio_content", "image_content"]);

const textEncoder = new TextEncoder();

export class LiveKitBridge implements VentLiveKitBridge {
  private readonly unsubscribers: Array<() => void> = [];
  private readonly participant: LiveKitLocalParticipantLike;

  constructor(
    ctx: LiveKitJobContextLike,
    private readonly session: LiveKitSessionLike,
  ) {
    const participant = ctx.room.localParticipant;
    if (!participant) throw new Error("instrumentLiveKitAgent needs a connected room: call it after ctx.connect().");
    this.participant = participant;
  }

  // ── Public API (arrow properties, so they work when destructured) ──

  publishCallMetadata = async (metadata: VentCallMetadata): Promise<void> => {
    await this.publish(TOPICS.callMetadata, { call_metadata: callMetadata(metadata) });
  };

  publishDebugUrl = async (label: string, url: string): Promise<void> => {
    await this.publish(TOPICS.debugUrl, { label, url });
  };

  publishWarning = async (message: string, extras?: Record<string, unknown>): Promise<void> => {
    await this.publish(TOPICS.warning, { message, ...extras });
  };

  dispose = (): void => {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  };

  // ── Session events ─────────────────────────────────────────

  /** Forward the session's events to Vent. */
  start(): void {
    const handlers: Array<[string, EventHandler]> = [
      ["metrics_collected", this.onMetrics],
      ["function_tools_executed", this.onFunctionToolsExecuted],
      ["conversation_item_added", this.onConversationItem],
      ["close", this.onClose],
    ];
    for (const [event, handler] of handlers) this.unsubscribers.push(subscribe(this.session, event, handler));
  }

  private onMetrics = (event: unknown): void => {
    this.publishSoon(TOPICS.metrics, fields(event), "metrics");
  };

  private onFunctionToolsExecuted = (event: unknown): void => {
    // One vent:tool-calls message per call, matched to its output by position.
    const calls = field(event, "functionCalls");
    const outputs = field(event, "functionCallOutputs");
    if (!Array.isArray(calls)) return;
    calls.forEach((call: unknown, i) => {
      const name = field(call, "name");
      if (!name) return;
      const output = Array.isArray(outputs) ? outputs[i] : undefined;
      let args = field(call, "args");
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { /* keep as string */ }
      }
      // LiveKit stamps the call when the LLM asks for it and the output when
      // the tool returns (ms), so the gap is how long the tool ran.
      const calledAt = field(call, "createdAt");
      const returnedAt = field(output, "createdAt");
      this.publishSoon(TOPICS.toolCalls, {
        type: "tool_call",
        name,
        arguments: args ?? {},
        result: field(output, "output"),
        successful: output ? !field(output, "isError") : undefined,
        duration_ms: typeof calledAt === "number" && typeof returnedAt === "number"
          ? Math.round(returnedAt - calledAt)
          : undefined,
      }, "tool call");
    });
  };

  private onConversationItem = (event: unknown): void => {
    const payload = fields(event);
    const item = field(event, "item");
    if (item) {
      const content = field(item, "content");
      payload["item"] = {
        ...fields(item),
        content: Array.isArray(content) ? content.filter((c) => !BINARY_CONTENT.has(field(c, "type") as string)) : content,
      };
    }
    this.publishSoon(TOPICS.conversationItem, payload, "conversation item");
  };

  private onClose = (event: unknown): void => {
    // Why the session ended: participant_disconnected, user_initiated,
    // task_completed, error or job_shutdown.
    const reason = field(event, "reason");
    if (typeof reason === "string") {
      this.publishSoon(TOPICS.callMetadata, { call_metadata: callMetadata({ ended_reason: reason }) }, "close reason");
    }
    const error = field(event, "error");
    if (error != null) {
      this.publishSoon(TOPICS.warning, { message: "LiveKit session closed with error", detail: error }, "close warning");
    }
  };

  // ── Publishing ─────────────────────────────────────────────

  private async publish(topic: Topic, payload: Record<string, unknown>): Promise<void> {
    const message = toJsonable({ type: topic, ...payload });
    await this.participant.publishData(textEncoder.encode(JSON.stringify(message)), { reliable: true, topic });
  }

  /** Publish from an event handler; a failure is logged, never thrown. */
  private publishSoon(topic: Topic, payload: Record<string, unknown>, context: string): void {
    this.publish(topic, payload).catch((error) => console.warn(`[vent-livekit] Failed to publish ${context}`, error));
  }

}

function callMetadata(metadata: VentCallMetadata): Record<string, unknown> {
  return { ...compact({ ...metadata }), platform: "livekit" };
}

function subscribe(emitter: LiveKitEventEmitterLike, event: string, listener: EventHandler): () => void {
  emitter.on(event, listener);
  return () => {
    if (typeof emitter.off === "function") emitter.off(event, listener);
    else emitter.removeListener?.(event, listener);
  };
}
