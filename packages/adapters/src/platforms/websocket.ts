/**
 * WebSocket Audio Channel
 *
 * Bidirectional PCM audio over WebSocket with comfort noise and real-time
 * audio pacing. Matches platform adapter quality for custom and local voice
 * agents.
 *
 * Binary frames → audio (PCM 16-bit mono, 24kHz)
 * Text frames   → JSON events (tool_call, vent:timing, speech-update, end-call)
 */

import type { ObservedToolCall, ComponentLatency, CallMetadata } from "@vent/shared";
import { WebSocketAudioChannel } from "../shared/websocket-channel.js";
import type { PlatformUtterance } from "../shared/audio-channel.js";
import {
  VENT_EVENTS,
  mergeCallMetadata,
  normalizeCallMetadata,
  observedToolCall,
  ventEventMetadata,
  type VentToolCallEvent,
} from "../shared/vent-events.js";

// ---- Config ----

interface WsAudioChannelConfig {
  wsUrl: string;
  headers?: Record<string, string>;
}

// ---- Text frame event types ----

interface WsTimingEvent {
  type: "vent:timing";
  stt_ms?: number;
  llm_ms?: number;
  tts_ms?: number;
}

interface WsTranscriptEvent {
  type: "vent:transcript";
  role?: string;
  text?: string;
}

// ---- Channel ----

export class WsAudioChannel extends WebSocketAudioChannel {
  protected readonly label = "Agent";
  private config: WsAudioChannelConfig;
  private toolCalls: ObservedToolCall[] = [];
  private pendingToolCallIds = new Set<string>();
  private componentTimings: ComponentLatency[] = [];
  private platformTranscripts: PlatformUtterance[] = [];
  private callMetadata: CallMetadata = { platform: "websocket" };
  private connectTimestamp = 0;

  /** VAD remains authority for turn endings. Agents can opt in via speech-update frames. */
  hasPlatformEndOfTurn = false;

  constructor(config: WsAudioChannelConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();
    await this.openSocket(this.config.wsUrl, { headers: this.config.headers }, (text) => this.handleTextFrame(text));
    this.connectTimestamp = Date.now();
    this._stats.connectLatencyMs = Date.now() - connectStart;
    // Start comfort noise to keep the connection active
    this.startComfortNoise();
  }

  async disconnect(): Promise<void> {
    this.stopComfortNoise();
    if (this.ws) {
      // Signal end-of-call before closing (best-effort)
      if (this.connected) {
        try {
          this.ws.send(JSON.stringify({ type: "end-call" }));
        } catch {
          // Non-fatal
        }
      }
      this.ws.close();
      this.ws = null;
    }
  }

  async getCallData(): Promise<ObservedToolCall[]> {
    return this.toolCalls;
  }

  async getCallMetadata(): Promise<CallMetadata | null> {
    return hasCallMetadataContent(this.callMetadata) ? this.callMetadata : null;
  }

  getComponentTimings(): ComponentLatency[] {
    return this.componentTimings;
  }

  getTranscripts(): PlatformUtterance[] {
    return this.platformTranscripts;
  }

  // ---- Text frame handling ----

  private handleTextFrame(text: string): void {
    try {
      this.handleEvent(JSON.parse(text) as { type: string; [key: string]: unknown });
    } catch {
      // Ignore malformed events
    }
  }

  private handleEvent(event: { type: string; [key: string]: unknown }): void {
    switch (event.type) {
      case "tool_call":
        this.handleToolCallEvent(event as unknown as VentToolCallEvent);
        break;
      case VENT_EVENTS.timing: {
        const timing = event as unknown as WsTimingEvent;
        this.componentTimings.push({
          stt_ms: timing.stt_ms,
          llm_ms: timing.llm_ms,
          tts_ms: timing.tts_ms,
        });
        break;
      }
      case "speech-update": {
        this.hasPlatformEndOfTurn = true;
        const status = event["status"];
        if (status === "started") {
          this.emit("platformSpeechStart");
        } else if (status === "stopped") {
          this.emit("platformEndOfTurn");
        }
        break;
      }
      case VENT_EVENTS.session:
        this.callMetadata = mergeCallMetadata(this.callMetadata, normalizeCallMetadata(event, "websocket"));
        break;
      case VENT_EVENTS.transcript:
        this.handleTranscriptEvent(event as unknown as WsTranscriptEvent);
        break;
      default: {
        const metadata = ventEventMetadata(event.type, event, "websocket");
        if (metadata) this.callMetadata = mergeCallMetadata(this.callMetadata, metadata);
      }
    }
  }

  private handleToolCallEvent(event: VentToolCallEvent): void {
    const isStart = event.in_progress === true;
    const isEnd = event.in_progress === false;
    if (event.name && !isStart) {
      this.toolCalls.push(observedToolCall(event, Date.now() - this.connectTimestamp));
    }
    if (isStart && event.tool_call_id && !this.pendingToolCallIds.has(event.tool_call_id)) {
      const wasEmpty = this.pendingToolCallIds.size === 0;
      this.pendingToolCallIds.add(event.tool_call_id);
      if (wasEmpty) this.emit("toolCallActive", true);
    } else if (isEnd && event.tool_call_id && this.pendingToolCallIds.has(event.tool_call_id)) {
      this.pendingToolCallIds.delete(event.tool_call_id);
      if (this.pendingToolCallIds.size === 0) this.emit("toolCallActive", false);
    }
  }

  private handleTranscriptEvent(event: WsTranscriptEvent): void {
    const text = typeof event.text === "string" ? event.text.trim() : "";
    if (!text) return;
    if (event.role === "caller" || event.role === "agent") this.platformTranscripts.push({ role: event.role, text });
  }
}

function hasCallMetadataContent(metadata: CallMetadata): boolean {
  return metadata.provider_call_id != null
    || metadata.provider_session_id != null
    || metadata.ended_reason != null
    || metadata.cost != null
    || metadata.recording_url != null
    || metadata.provider_warnings != null
    || metadata.provider_debug_urls != null
    || metadata.recording_variants != null
    || metadata.transfers != null;
}
