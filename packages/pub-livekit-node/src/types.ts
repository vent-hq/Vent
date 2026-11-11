/** Public types, and the minimal LiveKit shapes the helper relies on (it imports no LiveKit package). */

export type EventHandler = (...args: unknown[]) => void;

export type VentCallTransferStatus = "attempted" | "completed" | "cancelled" | "failed" | "unknown";
export type VentCallTransferSource = "platform_event" | "platform_metadata" | "tool_call";

/** Call cost in USD. `breakdown` uses your own category names; leave it out if you only know the total. */
export interface VentCallCost {
  total_usd: number;
  breakdown?: Record<string, number>;
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

/** Call metadata only the agent knows; `platform` is always set to `livekit`. */
export interface VentCallMetadata {
  provider_call_id?: string;
  provider_session_id?: string;
  ended_reason?: string;
  cost?: VentCallCost;
  recording_url?: string;
  recording_variants?: Record<string, string>;
  provider_debug_urls?: Record<string, string>;
  provider_warnings?: VentProviderWarning[];
  transfers?: VentCallTransfer[];
}

export interface LiveKitDataPublishOptions {
  reliable?: boolean;
  topic?: string;
}

export interface LiveKitLocalParticipantLike {
  publishData(data: Uint8Array, options: LiveKitDataPublishOptions): Promise<void>;
}

export interface LiveKitRoomLike {
  localParticipant?: LiveKitLocalParticipantLike;
}

export interface LiveKitEventEmitterLike {
  on(event: string, listener: EventHandler): unknown;
  off?(event: string, listener: EventHandler): unknown;
  removeListener?(event: string, listener: EventHandler): unknown;
}

export type LiveKitSessionLike = LiveKitEventEmitterLike;

export interface LiveKitJobContextLike {
  room: LiveKitRoomLike;
}

export interface InstrumentLiveKitAgentOptions {
  /** The job context. Its room carries the messages. */
  ctx: LiveKitJobContextLike;
  /** The agent session: source of metrics, tool calls, conversation items, and close events. */
  session: LiveKitSessionLike;
}

export interface VentLiveKitBridge {
  /** Call metadata only the agent knows, e.g. `cost` or `provider_call_id`. */
  publishCallMetadata(metadata: VentCallMetadata): Promise<void>;
  publishDebugUrl(label: string, url: string): Promise<void>;
  publishWarning(message: string, extras?: Record<string, unknown>): Promise<void>;
  /** Stop forwarding session events. */
  dispose(): void;
}
