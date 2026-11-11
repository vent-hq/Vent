/**
 * ElevenLabs Conversational AI Audio Channel (WebRTC)
 *
 * Connects directly to ElevenLabs' LiveKit Cloud via @livekit/rtc-node for
 * bidirectional audio. ElevenLabs uses LiveKit under the hood — we get a
 * LiveKit JWT from their token API and connect to wss://livekit.rtc.elevenlabs.io.
 *
 * Flow:
 *   1. connect()  — GET /v1/convai/conversation/token → LiveKit room.connect
 *   2. sendAudio() / on("audio") — bidirectional PCM 24kHz over WebRTC (48kHz internal)
 *   3. disconnect() — leaves room, ElevenLabs manages cleanup
 *   4. getCallData() — fetches tool calls via SDK conversations.get()
 *   5. getCallMetadata() — cost, duration, analysis
 *   6. getComponentTimings() — LLM TTFB from transcript turn metrics
 *   7. getTranscripts() — what ElevenLabs heard the caller say, and what its LLM wrote
 *
 * Agent end-of-turn detection: ElevenLabs has no "agent_stop_talking" signal.
 * We detect it from audio silence (350ms threshold), mirroring their SDK's
 * playback-drain approach and Pipecat's BOT_VAD_STOP pattern.
 *
 * Post-call data (tool calls, metadata, latency) fetched via SDK
 * client.conversationalAi.conversations.get(). Native audio is fetched via
 * client.conversationalAi.conversations.audio.get().
 */

import {
  RoomEvent,
  TrackKind,
  IceTransportType,
  ContinualGatheringPolicy,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "@livekit/rtc-node";
import { ElevenLabsClient, type ElevenLabs } from "@elevenlabs/elevenlabs-js";
import type { ObservedToolCall, CallMetadata, CallTransfer, ComponentLatency, ProviderWarning } from "@vent/shared";
import { CONNECT_TIMEOUT_MS, type PlatformUtterance } from "../shared/audio-channel.js";
import { LiveKitRoomChannel } from "../shared/livekit-room.js";
import { pollUntilReady, callDataUnavailableWarning } from "../shared/post-call.js";
import {
  compactNumberRecord,
  compactProviderWarning,
 
  dedupeProviderWarnings,
} from "../shared/record-utils.js";

type Conversation = ElevenLabs.GetConversationResponseModel;

interface ElevenLabsAudioChannelConfig {
  apiKey: string;
  agentId: string;
}

export class ElevenLabsAudioChannel extends LiveKitRoomChannel {
  private static readonly ELEVENLABS_LIVEKIT_URL = "wss://livekit.rtc.elevenlabs.io";
  private static readonly ELEVENLABS_API_ORIGIN = "https://api.elevenlabs.io";

  /** Send user_activity keep-alive every 20s to prevent ElevenLabs turn timeout.
   *  ElevenLabs docs recommend 30-60s; we use 20s for safety margin. */
  private static readonly USER_ACTIVITY_INTERVAL_MS = 20_000;

  /** ElevenLabs has no "agent stopped talking" signal, so Vent's own voice
   *  detection decides when the agent's turn ends. */
  hasPlatformEndOfTurn = false;

  private config: ElevenLabsAudioChannelConfig;
  private client: ElevenLabsClient;

  // Call state
  private conversationId: string | null = null;
  private cachedConversation: Conversation | null = null;

  // Live data-channel state: running tools keep the agent's turn open; warnings only arrive live
  private pendingToolCallIds = new Set<string>();
  private realtimeProviderWarnings: ProviderWarning[] = [];

  // user_activity keep-alive to prevent ElevenLabs turn timeout
  private _userActivityTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: ElevenLabsAudioChannelConfig) {
    super();
    this.config = config;
    this.client = new ElevenLabsClient({ apiKey: config.apiKey });
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();

    // Get LiveKit JWT from ElevenLabs token API
    const tokenUrl = `${ElevenLabsAudioChannel.ELEVENLABS_API_ORIGIN}/v1/convai/conversation/token?agent_id=${this.config.agentId}`;
    const tokenRes = await fetch(tokenUrl, {
      headers: { "xi-api-key": this.config.apiKey },
    });
    if (!tokenRes.ok) {
      throw new Error(
        `ElevenLabs token API returned ${tokenRes.status}: ${await tokenRes.text()}`
      );
    }
    const { token } = (await tokenRes.json()) as { token: string };
    if (!token) {
      throw new Error("ElevenLabs token API returned no token");
    }

    // Connect to ElevenLabs' LiveKit Cloud. It does not provide TURN servers
    // via signaling, so use TRANSPORT_ALL and let the peer connection
    // establish via direct UDP/TCP.
    const room = await this.joinRoom(ElevenLabsAudioChannel.ELEVENLABS_LIVEKIT_URL, token, {
      iceTransportType: IceTransportType.TRANSPORT_ALL,
      continualGatheringPolicy: ContinualGatheringPolicy.GATHER_CONTINUALLY,
      iceServers: [],
    });

    // Extract conversationId from room name (e.g. "conv_abc123...")
    if (room.name) {
      this.conversationId = room.name.match(/(conv_[a-zA-Z0-9]+)/)?.[0] ?? room.name;
    }

    // ── DataChannel listener for ElevenLabs JSON events ──────────
    room.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, participant?: RemoteParticipant) => {
        if (participant && !isElevenLabsAgent(participant)) return;
        this.handleDataEvent(payload);
      }
    );

    // ── Disconnect detection ─────────────────────────────────────
    // Clear `collecting` so `connected` turns false, but keep the room and
    // tracks — `disconnect()` needs them to release the FFI handles cleanly.
    room.once(RoomEvent.Disconnected, () => {
      this.collecting = false;
      this.emit("disconnected");
    });

    // ── Publish audio track (48kHz, microphone source) ───────────
    await this.publishCallerTrack();

    // ── Comfort noise — keep Opus codec warm ─────────────────────
    this.startComfortNoise();

    // ── Send conversation initiation via DataChannel ─────────────
    const initMsg = JSON.stringify({
      type: "conversation_initiation_client_data",
      conversation_config_override: {},
    });
    await room.localParticipant!.publishData(
      Buffer.from(initMsg),
      { reliable: true }
    );

    // ── Subscribe to agent audio tracks ──────────────────────────
    for (const participant of room.remoteParticipants.values()) {
      if (isElevenLabsAgent(participant)) {
        for (const pub of participant.trackPublications.values()) {
          if (pub.track && pub.kind === TrackKind.KIND_AUDIO) {
            void this.readAgentTrack(pub.track as RemoteTrack);
          }
        }
      }
    }

    room.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (isElevenLabsAgent(participant) && pub.kind === TrackKind.KIND_AUDIO) {
          void this.readAgentTrack(track);
        }
      }
    );

    // ── Wait for agent audio track ───────────────────────────────
    if (!await this.waitForAgentTrack(isElevenLabsAgent)) {
      throw new Error(
        `ElevenLabs agent did not publish audio within ${CONNECT_TIMEOUT_MS / 1000}s. ` +
        `Ensure the agent (${this.config.agentId}) is configured correctly in ElevenLabs.`
      );
    }

    // ── user_activity keep-alive ─────────────────────────────────
    // Prevents ElevenLabs turn timeout during long silences (tool calls, wait mode).
    this._userActivityTimer = setInterval(() => {
      if (!this.room?.localParticipant) return;
      const msg = JSON.stringify({ type: "user_activity" });
      this.room.localParticipant.publishData(
        Buffer.from(msg),
        { reliable: true },
      ).then(() => {
        console.log(`[elevenlabs] user_activity keep-alive sent`);
      }).catch((err) => {
        console.log(`[elevenlabs] user_activity send failed: ${err}`);
      });
    }, ElevenLabsAudioChannel.USER_ACTIVITY_INTERVAL_MS);

    this._stats.connectLatencyMs = Date.now() - connectStart;
  }

  async disconnect(): Promise<void> {
    if (this._userActivityTimer) {
      clearInterval(this._userActivityTimer);
      this._userActivityTimer = null;
    }
    await this.leaveRoom();
  }

  // ── Post-call data ─────────────────────────────────────────────

  async getCallData(): Promise<ObservedToolCall[]> {
    const data = await this.fetchConversation();
    if (!data) return [];
    return parseToolCalls(data).map(({ toolCall }) => toolCall);
  }

  async getCallMetadata(): Promise<CallMetadata | null> {
    const data = await this.fetchConversation();
    if (!data) {
      return {
        platform: "elevenlabs",
        provider_call_id: this.conversationId ?? undefined,
        provider_warnings: dedupeProviderWarnings([
          callDataUnavailableWarning("ElevenLabs"),
          ...this.realtimeProviderWarnings,
        ]),
      };
    }

    const meta = data.metadata;
    const charging = meta.charging;

    // `cost` is provider credits; cost_fiat is the USD total, split by ElevenLabs into LLM and platform.
    const breakdown = compactNumberRecord({ llm: charging?.llmPrice, platform: charging?.platformPrice });
    const cost: CallMetadata["cost"] = meta.costFiat != null
      ? { total_usd: meta.costFiat, ...(breakdown ? { breakdown } : {}) }
      : undefined;
    const conversationId = data.conversationId || this.conversationId || undefined;

    const providerWarnings = dedupeProviderWarnings([
      ...(extractElevenLabsProviderWarnings(meta) ?? []),
      ...this.realtimeProviderWarnings,
    ]);

    return {
      platform: "elevenlabs",
      provider_call_id: conversationId,
      ended_reason: meta.terminationReason,
      cost,
      provider_debug_urls: conversationId
        ? { dashboard: `https://elevenlabs.io/app/agents/history/${conversationId}` }
        : undefined,
      provider_warnings: providerWarnings,
      transfers: extractElevenLabsTransfers(parseToolCalls(data)),
    };
  }

  getComponentTimings(): ComponentLatency[] {
    return extractElevenLabsComponentTimings(this.cachedConversation);
  }

  getTranscripts(): PlatformUtterance[] {
    const utterances: PlatformUtterance[] = [];
    for (const msg of this.cachedConversation?.transcript ?? []) {
      // An interrupted agent turn's message is cut to what was spoken; originalMessage is the full text.
      const text = (msg.interrupted && msg.originalMessage) || msg.message;
      if ((msg.role === "user" || msg.role === "agent") && text) {
        utterances.push({ role: msg.role === "user" ? "caller" : "agent", text });
      }
    }
    return utterances;
  }

  // ── Private helpers ────────────────────────────────────────────

  private handleDataEvent(payload: Uint8Array): void {
    try {
      const text = new TextDecoder().decode(payload);
      const event = JSON.parse(text) as { type: string; [key: string]: unknown };

      switch (event.type) {
        case "conversation_initiation_metadata": {
          // Backup: extract conversationId if room.name parsing failed
          const convId = (event.conversation_initiation_metadata_event as { conversation_id?: string } | undefined)?.conversation_id;
          if (convId && !this.conversationId) {
            this.conversationId = convId;
          }
          break;
        }

        case "agent_response":
          this.emit("platformSpeechStart");
          break;

        case "client_tool_call": {
          const callId = (event.client_tool_call as LiveToolEvent).tool_call_id;
          this.markToolCallPending(callId);
          // Respond with client_tool_result so the agent doesn't hang waiting.
          // Vent is observation-only — we acknowledge with an empty success result.
          if (this.room?.localParticipant) {
            const result = JSON.stringify({
              type: "client_tool_result",
              tool_call_id: callId,
              result: "ok",
              is_error: false,
            });
            this.room.localParticipant.publishData(
              Buffer.from(result),
              { reliable: true },
            ).catch(() => {/* ignore */});
          }
          break;
        }

        case "mcp_tool_call": {
          const tool = event.mcp_tool_call as LiveToolEvent & { state: string };
          if (tool.state === "success" || tool.state === "failure") this.markToolCallComplete(tool.tool_call_id);
          else this.markToolCallPending(tool.tool_call_id);
          break;
        }

        case "agent_tool_request":
          this.markToolCallPending((event.agent_tool_request as LiveToolEvent).tool_call_id);
          break;

        case "agent_tool_response":
          this.markToolCallComplete((event.agent_tool_response as LiveToolEvent).tool_call_id);
          break;

        // The event carries no detail beyond its type.
        case "guardrail_triggered":
          this.recordRealtimeProviderWarning({ message: "ElevenLabs guardrail triggered", code: "guardrail_triggered" });
          break;

        // Sent when ElevenLabs closes the connection because of an error.
        case "error": {
          const error = event.error_event as { code: number; message?: string; error_type?: string };
          this.recordRealtimeProviderWarning({
            message: error.message ?? `ElevenLabs closed the connection (${error.code})`,
            code: error.error_type ?? String(error.code),
          });
          break;
        }

        case "ping": {
          // Respond with pong to keep connection alive
          const pingEvt = event.ping_event as { event_id?: number } | undefined;
          if (pingEvt?.event_id != null && this.room?.localParticipant) {
            const pong = JSON.stringify({ type: "pong", event_id: pingEvt.event_id });
            this.room.localParticipant.publishData(
              Buffer.from(pong),
              { reliable: true }
            ).catch(() => {/* ignore */});
          }
          break;
        }

        case "audio":
          // Skip — audio flows through LiveKit audio tracks in WebRTC mode
          break;
      }
    } catch {
      // Ignore malformed data
    }
  }

  private markToolCallPending(toolCallId: string): void {
    if (this.pendingToolCallIds.has(toolCallId)) return;
    const wasEmpty = this.pendingToolCallIds.size === 0;
    this.pendingToolCallIds.add(toolCallId);
    if (wasEmpty) this.emit("toolCallActive", true);
  }

  private markToolCallComplete(toolCallId: string): void {
    if (!this.pendingToolCallIds.has(toolCallId)) return;
    this.pendingToolCallIds.delete(toolCallId);
    if (this.pendingToolCallIds.size === 0) this.emit("toolCallActive", false);
  }

  private recordRealtimeProviderWarning(warning: ProviderWarning): void {
    const compacted = compactProviderWarning(warning);
    if (!compacted) return;
    this.realtimeProviderWarnings = dedupeProviderWarnings([
      ...this.realtimeProviderWarnings,
      compacted,
    ]) ?? [];
  }

  private conversationData?: Promise<Conversation | null>;

  /** One shared fetch per call. ElevenLabs reports "processing" until the conversation is final. */
  private fetchConversation(): Promise<Conversation | null> {
    if (!this.conversationId) return Promise.resolve(null);
    const conversationId = this.conversationId;
    this.conversationData ??= pollUntilReady(
      "elevenlabs-postcall",
      () => this.client.conversationalAi.conversations.get(conversationId),
      (data) => data.status === "done" || data.status === "failed",
    ).then((data) => (this.cachedConversation = data));
    return this.conversationData;
  }
}

function isElevenLabsAgent(participant: RemoteParticipant): boolean {
  return participant.identity.startsWith("agent");
}

/** The id ElevenLabs puts on every live tool event. */
interface LiveToolEvent {
  tool_call_id: string;
}

interface ElevenLabsToolCall {
  toolCall: ObservedToolCall;
  /** Error reported with the tool's result, if any. */
  error?: string;
}

/** Tool calls from the post-call transcript, each matched to its result by request id. */
function parseToolCalls(data: Conversation): ElevenLabsToolCall[] {
  const results = new Map(
    data.transcript.flatMap((msg) => msg.toolResults ?? []).map((tr) => [tr.requestId, tr]),
  );

  const toolCalls: ElevenLabsToolCall[] = [];
  for (const msg of data.transcript) {
    for (const tc of msg.toolCalls ?? []) {
      const result = results.get(tc.requestId);
      toolCalls.push({
        toolCall: {
          name: tc.toolName,
          arguments: JSON.parse(tc.paramsAsJson) as Record<string, unknown>,
          result: result?.resultValue,
          successful: result ? !result.isError : undefined,
          provider_tool_type: tc.type,
          timestamp_ms: msg.timeInCallSecs * 1000,
          latency_ms: result?.toolLatencySecs != null ? result.toolLatencySecs * 1000 : undefined,
        },
        error: result?.isError ? result.rawErrorMessage || result.errorType || "tool_error" : undefined,
      });
    }
  }
  return toolCalls;
}

/** Per-turn STT, LLM and TTS latency from the metrics ElevenLabs records on each agent turn. */
function extractElevenLabsComponentTimings(data: Conversation | null): ComponentLatency[] {
  const timings: ComponentLatency[] = [];
  for (const msg of data?.transcript ?? []) {
    const metrics = msg.role === "agent" ? msg.conversationTurnMetrics?.metrics : undefined;
    if (!metrics) continue;
    const ms = (key: string) => {
      const seconds = metrics[key]?.elapsedTime;
      return seconds != null ? seconds * 1000 : undefined;
    };
    const timing = {
      stt_ms: ms("convai_turn_asr_latency"),
      llm_ms: ms("convai_llm_service_ttfb"),
      tts_ms: ms("convai_tts_service_ttfb"),
    };
    if (timing.stt_ms != null || timing.llm_ms != null || timing.tts_ms != null) timings.push(timing);
  }
  return timings;
}

function extractElevenLabsProviderWarnings(meta: ElevenLabs.ConversationHistoryMetadataCommonModel): ProviderWarning[] {
  const warnings: ProviderWarning[] = (meta.warnings ?? []).map((message) => ({ message }));
  if (meta.error) {
    warnings.push({ message: meta.error.reason ?? `ElevenLabs error ${meta.error.code}`, code: String(meta.error.code) });
  }
  return warnings;
}

/** ElevenLabs' built-in transfer tools, with the argument that holds each one's destination. */
const TRANSFER_DESTINATION_ARG: Record<string, string> = {
  transfer_to_number: "transfer_number",
  transfer_to_agent: "agent_number",
};

function extractElevenLabsTransfers(toolCalls: ElevenLabsToolCall[]): CallTransfer[] | undefined {
  const transfers: CallTransfer[] = [];
  for (const { toolCall } of toolCalls) {
    const destinationArg = TRANSFER_DESTINATION_ARG[toolCall.name];
    if (!destinationArg) continue;
    const destination = toolCall.arguments[destinationArg];
    transfers.push({
      type: toolCall.name,
      destination: destination != null ? String(destination) : undefined,
      status: toolCall.successful === undefined ? "attempted" : toolCall.successful ? "completed" : "failed",
      sources: toolCall.successful === undefined ? ["tool_call"] : ["tool_call", "platform_metadata"],
      timestamp_ms: toolCall.timestamp_ms,
    });
  }
  return transfers.length > 0 ? transfers : undefined;
}
