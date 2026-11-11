const LIVEKIT_VENT_TOPICS = {
  callMetadata: "vent:call-metadata",
  debugUrl: "vent:debug-url",
  warning: "vent:warning",
  metrics: "vent:metrics",
  toolCalls: "vent:tool-calls",
  transfer: "vent:transfer",
  conversationItem: "vent:conversation-item",
  userInputTranscribed: "vent:user-input-transcribed",
  sessionUsage: "vent:session-usage",
  sessionReport: "vent:session-report",
} as const;

type VentTopic = (typeof LIVEKIT_VENT_TOPICS)[keyof typeof LIVEKIT_VENT_TOPICS];

type EventHandler = (...args: unknown[]) => void;

export type VentCallTransferStatus = "attempted" | "completed" | "cancelled" | "failed" | "unknown";
export type VentCallTransferSource = "platform_event" | "platform_metadata" | "tool_call";

export interface VentCostBreakdown {
  stt_usd?: number;
  llm_usd?: number;
  tts_usd?: number;
  transport_usd?: number;
  platform_usd?: number;
  total_usd?: number;
  llm_prompt_tokens?: number;
  llm_completion_tokens?: number;
}

export interface VentProviderWarning {
  message?: string;
  code?: string;
  detail?: unknown;
}

export interface VentCallTransfer {
  type: string;
  destination?: string;
  status: VentCallTransferStatus;
  sources: VentCallTransferSource[];
  timestamp_ms?: number;
}

export interface VentCallMetadata {
  platform: string;
  provider_call_id?: string;
  provider_session_id?: string;
  ended_reason?: string;
  cost_usd?: number;
  cost_breakdown?: VentCostBreakdown;
  recording_url?: string;
  recording_variants?: Record<string, string>;
  provider_debug_urls?: Record<string, string>;
  variables?: Record<string, unknown>;
  provider_warnings?: VentProviderWarning[];
  provider_metadata?: Record<string, unknown>;
  transfers?: VentCallTransfer[];
}

export interface LiveKitDataPublishOptions {
  reliable?: boolean;
  topic?: string;
  destination_identities?: string[];
}

export interface LiveKitLocalParticipantLike {
  publishData(data: Uint8Array, options: LiveKitDataPublishOptions): Promise<void>;
}

export interface LiveKitRoomLike {
  name?: string;
  sid?: string;
  localParticipant?: LiveKitLocalParticipantLike;
}

export interface LiveKitEventEmitterLike {
  on(event: string, listener: EventHandler): unknown;
  off?(event: string, listener: EventHandler): unknown;
  removeListener?(event: string, listener: EventHandler): unknown;
}

export interface LiveKitSessionLike extends LiveKitEventEmitterLike {
  history?: unknown;
}

export interface LiveKitJobContextLike {
  room?: LiveKitRoomLike;
  /** LiveKit Agents SDK >=1.x — build the canonical session report. */
  makeSessionReport?(session?: LiveKitSessionLike): unknown;
}

export interface VentLiveKitLogger {
  warn(message: string, error?: unknown): void;
}

export interface InstrumentLiveKitAgentOptions {
  room?: LiveKitRoomLike;
  participant?: LiveKitLocalParticipantLike;
  session?: LiveKitSessionLike;
  ctx?: LiveKitJobContextLike;
  reliable?: boolean;
  logger?: VentLiveKitLogger;
  /** Optional extra metadata not already visible from the LiveKit room itself. */
  sessionMetadata?: Partial<VentCallMetadata>;
  debugUrls?: Record<string, string>;
  /**
   * Auto-publish a session report on `vent:session-report` when the session
   * closes. Default: true. The helper subscribes to the session's `close`
   * event, which fires BEFORE `room.disconnect()` — publishing in
   * `ctx.addShutdownCallback()` runs after the transport is torn down and
   * fails with "engine is closed".
   */
  autoPublishSessionReport?: boolean;
}

export interface VentLiveKitBridge {
  publishCallMetadata(metadata: Partial<VentCallMetadata>): Promise<void>;
  publishDebugUrl(label: string, url: string): Promise<void>;
  publishWarning(message: string, extras?: Record<string, unknown>): Promise<void>;
  publishSessionUsage(usage: Record<string, unknown>): Promise<void>;
  /**
   * Publish a session report on `vent:session-report`. If `report` is omitted
   * and `ctx` was passed to the helper, falls back to `ctx.makeSessionReport(session)`.
   * Must be called while the room transport is still alive — by default the
   * helper already publishes one on `session.close`.
   */
  publishSessionReport(report?: Record<string, unknown>): Promise<void>;
  dispose(): void;
}

const textEncoder = new TextEncoder();

export function instrumentLiveKitAgent(options: InstrumentLiveKitAgentOptions): VentLiveKitBridge {
  const room = options.room ?? options.ctx?.room;
  const participant = options.participant ?? room?.localParticipant;

  if (!participant) {
    throw new Error("instrumentLiveKitAgent requires a LiveKit localParticipant or room.");
  }

  const logger = options.logger ?? defaultLogger;
  const reliable = options.reliable ?? true;
  const teardownFns: Array<() => void> = [];

  const publish = async (topic: VentTopic, payload: Record<string, unknown>): Promise<void> => {
    const message = {
      type: topic,
      ...payload,
    };
    await participant.publishData(
      textEncoder.encode(JSON.stringify(sanitizeForJson(message))),
      { reliable, topic },
    );
  };

  const publishCallMetadata = async (metadata: Partial<VentCallMetadata>): Promise<void> => {
    await publish(LIVEKIT_VENT_TOPICS.callMetadata, {
      call_metadata: compactRecord({
        platform: "livekit",
        ...metadata,
      }) ?? { platform: "livekit" },
    });
  };

  const publishDebugUrl = async (label: string, url: string): Promise<void> => {
    await publish(LIVEKIT_VENT_TOPICS.debugUrl, { label, url });
  };

  const publishWarning = async (message: string, extras?: Record<string, unknown>): Promise<void> => {
    await publish(LIVEKIT_VENT_TOPICS.warning, {
      message,
      ...asRecord(extras ?? {}),
    });
  };

  const publishMetrics = async (event: Record<string, unknown>): Promise<void> => {
    await publish(LIVEKIT_VENT_TOPICS.metrics, {
      event: "metrics_collected",
      ...event,
    });
  };

  const publishToolCall = async (toolCall: Record<string, unknown>): Promise<void> => {
    await publish(LIVEKIT_VENT_TOPICS.toolCalls, {
      type: "tool_call",
      ...toolCall,
    });
  };

  const publishTransfer = async (transfer: Record<string, unknown>): Promise<void> => {
    await publish(LIVEKIT_VENT_TOPICS.transfer, transfer);
  };

  const handleFunctionToolsExecuted = (event: Record<string, unknown>): void => {
    // Node Agents SDK emits camelCase: functionCalls/functionCallOutputs with
    // callId/args/name on each call and callId/output/isError on each output.
    // Normalize to per-call vent:tool-calls messages (Vent's canonical shape).
    const functionCalls = event["functionCalls"] as Array<Record<string, unknown>> | undefined;
    const functionCallOutputs = event["functionCallOutputs"] as Array<Record<string, unknown> | null> | undefined;

    if (Array.isArray(functionCalls)) {
      for (let i = 0; i < functionCalls.length; i++) {
        const fc = functionCalls[i];
        if (!fc || !fc["name"]) continue;
        const output = Array.isArray(functionCallOutputs) ? functionCallOutputs[i] : undefined;

        let parsedArgs: unknown = fc["args"];
        if (typeof parsedArgs === "string") {
          try { parsedArgs = JSON.parse(parsedArgs); } catch { /* keep as string */ }
        }

        safePublish(() => publishToolCall({
          name: fc["name"],
          arguments: parsedArgs ?? {},
          call_id: fc["callId"],
          result: output?.["output"] ?? undefined,
          successful: output ? !output["isError"] : undefined,
        }), "tool_call");
      }
    }

    if (event["hasAgentHandoff"]) {
      const destination = (event["newAgentId"] ?? event["newAgentType"]) as string | undefined;
      safePublish(() => publishTransfer({
        type: "vent:transfer",
        transfer_type: "agent_handoff",
        destination,
        status: "completed",
        source: "platform_event",
      }), "agent handoff transfer");
    }
  };

  const publishConversationItem = async (event: Record<string, unknown>): Promise<void> => {
    // ChatMessage.content can contain AudioContent (AudioFrame) and
    // ImageContent (VideoFrame) which aren't JSON-serializable.
    // Strip binary content, keep only text.
    const item = event["item"] as Record<string, unknown> | undefined;
    if (item && Array.isArray(item["content"])) {
      item["content"] = (item["content"] as unknown[]).filter((c) => {
        if (typeof c === "string") return true;
        if (c && typeof c === "object" && "type" in c) {
          const t = (c as Record<string, unknown>)["type"];
          return t !== "audio_content" && t !== "image_content";
        }
        return true;
      });
    }
    await publish(LIVEKIT_VENT_TOPICS.conversationItem, {
      event: "conversation_item_added",
      ...event,
    });
  };

  const publishUserInputTranscribed = async (event: Record<string, unknown>): Promise<void> => {
    await publish(LIVEKIT_VENT_TOPICS.userInputTranscribed, {
      event: "user_input_transcribed",
      ...event,
    });
  };

  const publishSessionUsage = async (usage: Record<string, unknown>): Promise<void> => {
    await publish(LIVEKIT_VENT_TOPICS.sessionUsage, { usage });
  };

  const tryBuildSessionReport = (): Record<string, unknown> | undefined => {
    const ctx = options.ctx;
    if (!ctx || typeof ctx.makeSessionReport !== "function") return undefined;
    try {
      const report = ctx.makeSessionReport(options.session);
      return asRecord(report);
    } catch (error) {
      logger.warn("Failed to build LiveKit session report", error);
      return undefined;
    }
  };

  const publishSessionReport = async (report?: Record<string, unknown>): Promise<void> => {
    const finalReport = report ?? tryBuildSessionReport();
    if (!finalReport) return;
    await publish(LIVEKIT_VENT_TOPICS.sessionReport, { report: finalReport });
  };

  const safePublish = (operation: () => Promise<void>, context: string) => {
    void operation().catch((error) => {
      logger.warn(`Failed to publish LiveKit ${context}`, error);
    });
  };

  if (options.session) {
    const unsubscribe = subscribe(options.session, "metrics_collected", (event) => {
      safePublish(() => publishMetrics(asRecord(event)), "metrics_collected event");
    });
    teardownFns.push(unsubscribe);

    teardownFns.push(subscribe(options.session, "function_tools_executed", (event) => {
      handleFunctionToolsExecuted(asRecord(event));
    }));

    teardownFns.push(subscribe(options.session, "conversation_item_added", (event) => {
      safePublish(() => publishConversationItem(asRecord(event)), "conversation_item_added event");
    }));

    teardownFns.push(subscribe(options.session, "user_input_transcribed", (event) => {
      safePublish(() => publishUserInputTranscribed(asRecord(event)), "user_input_transcribed event");
    }));

    teardownFns.push(subscribe(options.session, "session_usage_updated", (event) => {
      const payload = asRecord(event);
      safePublish(() => publishSessionUsage(asRecord(payload["usage"]) ?? payload), "session_usage_updated event");
    }));

    teardownFns.push(subscribe(options.session, "close", (event) => {
      const payload = asRecord(event);
      const closeError = payload["error"];
      if (closeError != null) {
        safePublish(
          () => publishWarning("LiveKit session closed with error", { error: sanitizeForJson(closeError) }),
          "close warning",
        );
      }
      // session.close fires before room.disconnect — this is the last safe
      // window to publish on the DataChannel. Kicking off the publish here
      // and racing it against _onSessionEnd (which awaits a cloud upload)
      // gives the FFI round-trip plenty of time to complete.
      if (options.autoPublishSessionReport !== false) {
        safePublish(() => publishSessionReport(), "session report");
      }
    }));
  }

  const extraMetadata = filterSessionMetadataForInAgentOnlySignals(options.sessionMetadata, room);
  if (extraMetadata) {
    safePublish(() => publishCallMetadata(extraMetadata), "call metadata");
  }

  for (const [label, url] of Object.entries(options.debugUrls ?? {})) {
    safePublish(() => publishDebugUrl(label, url), `debug url (${label})`);
  }

  return {
    publishCallMetadata,
    publishDebugUrl,
    publishWarning,
    publishSessionUsage,
    publishSessionReport,
    dispose() {
      for (const teardown of teardownFns.splice(0)) {
        teardown();
      }
    },
  };
}

function subscribe(
  emitter: LiveKitEventEmitterLike,
  eventName: string,
  listener: EventHandler,
): () => void {
  emitter.on(eventName, listener);
  return () => {
    if (typeof emitter.off === "function") {
      emitter.off(eventName, listener);
      return;
    }
    if (typeof emitter.removeListener === "function") {
      emitter.removeListener(eventName, listener);
    }
  };
}

function filterSessionMetadataForInAgentOnlySignals(
  metadata: Partial<VentCallMetadata> | undefined,
  room: LiveKitRoomLike | undefined,
): Partial<VentCallMetadata> | undefined {
  if (!metadata) return undefined;

  const providerSessionId = metadata.provider_session_id;
  const roomVisibleSessionId = room?.name ?? room?.sid;
  return compactRecord({
    ...metadata,
    platform: undefined,
    provider_session_id: providerSessionId && providerSessionId !== roomVisibleSessionId
      ? providerSessionId
      : undefined,
  }) as Partial<VentCallMetadata> | undefined;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value != null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return sanitizeForJson(value) as Record<string, unknown>;
}

function sanitizeForJson(value: unknown, depth = 0): unknown {
  if (value == null || depth > 8) return value ?? null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return compactRecord({
      name: value.name,
      message: value.message,
      stack: value.stack,
    }) ?? { message: value.message };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForJson(item, depth + 1));
  }
  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries()).map(([key, mapValue]) => [String(key), sanitizeForJson(mapValue, depth + 1)]),
    );
  }
  if (value instanceof Set) {
    return Array.from(value.values()).map((item) => sanitizeForJson(item, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => typeof nested !== "function" && typeof nested !== "symbol")
      .map(([key, nested]) => [key, sanitizeForJson(nested, depth + 1)]);
    return Object.fromEntries(entries);
  }
  return String(value);
}

const defaultLogger: VentLiveKitLogger = {
  warn(message, error) {
    if (error) {
      console.warn(`[vent-livekit] ${message}`, error);
    } else {
      console.warn(`[vent-livekit] ${message}`);
    }
  },
};
