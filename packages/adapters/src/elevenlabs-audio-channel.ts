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
 *   7. getComponentTimings() — LLM TTFB from transcript turn metrics
 *   8. getTranscripts() — platform STT transcripts for cross-referencing
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
  Room,
  RoomEvent,
  AudioSource,
  AudioStream,
  AudioFrame,
  LocalAudioTrack,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  IceTransportType,
  ContinualGatheringPolicy,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "@livekit/rtc-node";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { ObservedToolCall, CallMetadata, CallTransfer, ComponentLatency, CostBreakdown, ProviderWarning, UsageEntry } from "@vent/shared";
import { resample } from "@vent/voice";
import { BaseAudioChannel, CONNECT_TIMEOUT_MS, type SendAudioOptions } from "./audio-channel.js";
import { pollUntilReady, callDataUnavailableWarning } from "./post-call.js";

export interface ElevenLabsAudioChannelConfig {
  apiKey: string;
  agentId: string;
}

export class ElevenLabsAudioChannel extends BaseAudioChannel {
  private static readonly ELEVENLABS_LIVEKIT_URL = "wss://livekit.rtc.elevenlabs.io";
  private static readonly ELEVENLABS_API_ORIGIN = "https://api.elevenlabs.io";
  private static readonly AGENT_IDENTITY_PREFIX = "agent";
  private static readonly LIVEKIT_SAMPLE_RATE = 48000;

  /** Send user_activity keep-alive every 20s to prevent ElevenLabs turn timeout.
   *  ElevenLabs docs recommend 30-60s; we use 20s for safety margin. */
  private static readonly USER_ACTIVITY_INTERVAL_MS = 20_000;

  /** ElevenLabs has no "agent stopped talking" signal, so Vent's own voice
   *  detection decides when the agent's turn ends. */
  hasPlatformEndOfTurn = false;

  private config: ElevenLabsAudioChannelConfig;
  private client: ElevenLabsClient;

  // LiveKit room state
  private room: Room | null = null;
  private audioSource: AudioSource | null = null;
  private localTrack: LocalAudioTrack | null = null;
  private collecting = false;

  // Call state
  private conversationId: string | null = null;
  private cachedConversation: Record<string, unknown> | null = null;
  private connectTimestamp = 0;
  private disconnectTimestamp = 0;

  // Live data-channel backups, used when the post-call fetch fails
  private realtimeUserTranscripts: string[] = [];
  private realtimeToolCalls: ObservedToolCall[] = [];
  private realtimeToolCallIndexById = new Map<string, number>();
  private pendingToolCallIds = new Set<string>();
  private realtimeProviderWarnings: ProviderWarning[] = [];
  private realtimeProviderMetadata: Record<string, unknown[]> = {};

  // user_activity keep-alive to prevent ElevenLabs turn timeout
  private _userActivityTimer: ReturnType<typeof setInterval> | null = null;

  protected override outputSampleRate = ElevenLabsAudioChannel.LIVEKIT_SAMPLE_RATE;

  constructor(config: ElevenLabsAudioChannelConfig) {
    super();
    this.config = config;
    this.client = new ElevenLabsClient({ apiKey: config.apiKey });
  }

  get connected(): boolean {
    return this.room !== null && this.collecting;
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();
    this.enableRecordingCapture();

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

    // Connect to ElevenLabs' LiveKit Cloud
    this.room = new Room();

    // ElevenLabs' LiveKit (livekit.rtc.elevenlabs.io) does not provide TURN
    // servers via signaling, unlike Retell's LiveKit Cloud. Use TRANSPORT_ALL
    // so the peer connection can establish via direct UDP/TCP.
    const rtcConfig = {
      iceTransportType: IceTransportType.TRANSPORT_ALL,
      continualGatheringPolicy: ContinualGatheringPolicy.GATHER_CONTINUALLY,
      iceServers: [],
    };

    await this.room.connect(ElevenLabsAudioChannel.ELEVENLABS_LIVEKIT_URL, token, {
      autoSubscribe: true,
      dynacast: true,
      rtcConfig,
    });
    this.collecting = true;
    this.connectTimestamp = Date.now();
    this._connectTimestampMs = this.connectTimestamp;
    this._connectMonotonicMs = performance.now();
    this.realtimeUserTranscripts = [];
    this.realtimeToolCalls = [];
    this.realtimeToolCallIndexById.clear();
    this.pendingToolCallIds.clear();
    this.realtimeProviderWarnings = [];
    this.realtimeProviderMetadata = {};

    // Extract conversationId from room name (e.g. "conv_abc123...")
    if (this.room.name) {
      this.conversationId = this.room.name.match(/(conv_[a-zA-Z0-9]+)/)?.[0] ?? this.room.name;
    }

    // ── DataChannel listener for ElevenLabs JSON events ──────────
    this.room.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, participant?: RemoteParticipant) => {
        if (participant && !participant.identity.startsWith(ElevenLabsAudioChannel.AGENT_IDENTITY_PREFIX)) return;
        this.handleDataEvent(payload);
      }
    );

    // ── Disconnect detection ─────────────────────────────────────
    // Same pattern as retell-audio-channel: clear `collecting` so the
    // `connected` getter returns false (it's `room !== null && collecting`),
    // but don't null `room`/`audioSource`/`localTrack` — `disconnect()`
    // needs them to release the FFI handles cleanly.
    this.room.once(RoomEvent.Disconnected, () => {
      this.collecting = false;
      this.emit("disconnected");
    });

    // ── Publish audio track (48kHz, microphone source) ───────────
    this.audioSource = new AudioSource(ElevenLabsAudioChannel.LIVEKIT_SAMPLE_RATE, 1);
    this.localTrack = LocalAudioTrack.createAudioTrack("vent-tester", this.audioSource);
    const publishOptions = new TrackPublishOptions();
    publishOptions.source = TrackSource.SOURCE_MICROPHONE;
    await this.room.localParticipant!.publishTrack(this.localTrack, publishOptions);

    // ── Comfort noise — keep Opus codec warm ─────────────────────
    this.startComfortNoise();

    // ── Send conversation initiation via DataChannel ─────────────
    const initMsg = JSON.stringify({
      type: "conversation_initiation_client_data",
      conversation_config_override: {},
    });
    await this.room.localParticipant!.publishData(
      Buffer.from(initMsg),
      { reliable: true }
    );

    // ── Subscribe to agent audio tracks ──────────────────────────
    for (const participant of this.room.remoteParticipants.values()) {
      if (participant.identity.startsWith(ElevenLabsAudioChannel.AGENT_IDENTITY_PREFIX)) {
        for (const pub of participant.trackPublications.values()) {
          if (pub.track && pub.kind === TrackKind.KIND_AUDIO) {
            this.startReadingTrack(pub.track as RemoteTrack);
          }
        }
      }
    }

    this.room.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (participant.identity.startsWith(ElevenLabsAudioChannel.AGENT_IDENTITY_PREFIX) && pub.kind === TrackKind.KIND_AUDIO) {
          this.startReadingTrack(track);
        }
      }
    );

    // ── Wait for agent audio track ───────────────────────────────
    const agentReady = await new Promise<boolean>((resolve) => {
      // Define listener first so timeout cleanup can reference it
      const onTrackSubscribed = (_t: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (participant.identity.startsWith(ElevenLabsAudioChannel.AGENT_IDENTITY_PREFIX) && pub.kind === TrackKind.KIND_AUDIO) {
          clearTimeout(timer);
          this.room?.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
          resolve(true);
        }
      };

      const timer = setTimeout(() => {
        this.room?.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
        resolve(false);
      }, CONNECT_TIMEOUT_MS);

      // Check if already subscribed
      for (const p of this.room!.remoteParticipants.values()) {
        if (p.identity.startsWith(ElevenLabsAudioChannel.AGENT_IDENTITY_PREFIX)) {
          for (const pub of p.trackPublications.values()) {
            if (pub.track && pub.kind === TrackKind.KIND_AUDIO) {
              clearTimeout(timer);
              this.room?.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
              resolve(true);
              return;
            }
          }
        }
      }

      this.room!.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    });

    if (!agentReady) {
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

  protected override clearTransportQueue(): void {
    this.audioSource?.clearQueue();
  }

  // ── Audio I/O ──────────────────────────────────────────────────

  /** Write a single 20ms audio frame to LiveKit's AudioSource. */
  protected async writeAudioFrame(samples: Int16Array, sampleRate: number): Promise<void> {
    if (!this.audioSource || !this.collecting) return;
    const copied = new Int16Array(samples);
    const frame = new AudioFrame(copied, sampleRate, 1, copied.length);
    await this.audioSource.captureFrame(frame);
  }

  override sendAudio(pcm: Buffer, opts?: SendAudioOptions): void {
    if (!this.audioSource || !this.collecting) return;
    super.sendAudio(pcm, opts);
  }

  async disconnect(): Promise<void> {
    this.collecting = false;
    this.stopComfortNoise();
    if (this._userActivityTimer) {
      clearInterval(this._userActivityTimer);
      this._userActivityTimer = null;
    }
    this.disconnectTimestamp = Date.now();
    if (this.audioSource) {
      await this.audioSource.close();
      this.audioSource = null;
    }
    if (this.localTrack) {
      await this.localTrack.close();
      this.localTrack = null;
    }
    if (this.room) {
      await this.room.disconnect();
      this.room = null;
    }
    // NOTE: Do NOT call dispose() — destroys global FFI runtime
  }

  // ── Post-call data ─────────────────────────────────────────────

  async getCallData(): Promise<ObservedToolCall[]> {
    const data = await this.fetchConversation();
    if (!data) return this.realtimeToolCalls;
    const parsed = this.parseToolCalls(data);
    return parsed.length > 0 ? parsed : this.realtimeToolCalls;
  }

  async getCallMetadata(): Promise<CallMetadata | null> {
    const data = await this.fetchConversation();
    if (!data) {
      const providerWarnings = dedupeProviderWarnings([
        callDataUnavailableWarning("ElevenLabs"),
        ...this.realtimeProviderWarnings,
      ]);
      const providerMetadata = compactRealtimeProviderMetadata(this.realtimeProviderMetadata);
      return {
        platform: "elevenlabs",
        provider_call_id: this.conversationId ?? undefined,
        provider_warnings: providerWarnings,
        provider_metadata: providerMetadata,
      };
    }

    const meta = data.metadata as Record<string, unknown> | undefined;
    const charging = meta?.charging as Record<string, unknown> | undefined;
    const analysis = data.analysis as Record<string, unknown> | undefined;

    // `cost` is provider credits; only cost_fiat is the conversation total in USD.
    const costBreakdown: CostBreakdown | undefined = charging ? {
      llm_usd: charging.llmPrice as number | undefined,
    } : undefined;

    const callSuccessful = analysis?.callSuccessful as string | undefined;
    const providerWarnings = dedupeProviderWarnings([
      ...(extractElevenLabsProviderWarnings(meta) ?? []),
      ...this.realtimeProviderWarnings,
    ]);

    return {
      platform: "elevenlabs",
      provider_call_id: (data.conversationId as string | undefined) || this.conversationId || undefined,
      ended_reason: meta?.terminationReason as string | undefined,
      cost_usd: typeof meta?.costFiat === "number" ? meta.costFiat : undefined,
      cost_breakdown: costBreakdown,
      usage: extractElevenLabsUsage(data),
      provider_warnings: providerWarnings,
      provider_metadata: compactUnknownRecord({
        duration_s: meta?.callDurationSecs as number | undefined,
        has_audio: data.hasAudio,
        has_user_audio: data.hasUserAudio,
        has_response_audio: data.hasResponseAudio,
        phone_call: meta?.phoneCall,
        rag_usage: meta?.ragUsage,
        cost_credits: meta?.cost,
        data_collection_results: analysis?.dataCollectionResults,
      }),
      transfers: extractElevenLabsTransfers(data),
    };
  }

  getComponentTimings(): ComponentLatency[] {
    return extractElevenLabsComponentTimings(this.cachedConversation);
  }

  getTranscripts(): Array<{ turnIndex: number; text: string }> {
    const data = this.cachedConversation;
    const transcript = data?.transcript as Array<Record<string, unknown>> | undefined;
    if (!transcript) {
      return this.realtimeUserTranscripts.map((text, turnIndex) => ({ turnIndex, text }));
    }

    const transcripts: Array<{ turnIndex: number; text: string }> = [];
    let callerTurnIndex = 0;
    for (const msg of transcript) {
      if (msg.role === "user" && typeof msg.message === "string") {
        transcripts.push({ turnIndex: callerTurnIndex, text: msg.message });
        callerTurnIndex++;
      }
    }
    return transcripts;
  }

  // ── Private helpers ────────────────────────────────────────────

  private handleDataEvent(payload: Uint8Array): void {
    try {
      const text = new TextDecoder().decode(payload);
      const event = JSON.parse(text) as { type: string; [key: string]: unknown };

      switch (event.type) {
        case "conversation_initiation_metadata": {
          // Backup: extract conversationId if room.name parsing failed
          const metaEvent = event.conversation_initiation_metadata_event as { conversation_id?: string } | undefined;
          const convId = metaEvent?.conversation_id ?? event.conversation_id as string | undefined;
          if (convId && !this.conversationId) {
            this.conversationId = convId;
          }
          break;
        }

        case "agent_response":
          this.emit("platformSpeechStart");
          break;

        case "user_transcript": {
          const evt = firstRecord(
            event.user_transcription_event,
            event.user_transcript_event,
          );
          const transcript = firstString(
            evt?.user_transcript,
            evt?.transcript,
            event.user_transcript,
            event.transcript,
            event.text,
          );
          if (transcript) {
            this.realtimeUserTranscripts.push(transcript);
          }
          break;
        }

        case "tentative_user_transcript": {
          this.appendRealtimeProviderMetadataListItem(
            "elevenlabs_tentative_user_transcripts",
            compactUnknownRecord({
              transcript: firstString(
                firstRecord(event.tentative_user_transcription_event, event.tentative_user_transcript_event)?.transcript,
                firstRecord(event.tentative_user_transcription_event, event.tentative_user_transcript_event)?.user_transcript,
                event.transcript,
                event.user_transcript,
                event.text,
              ),
              ...event,
            }) ?? event,
          );
          break;
        }

        case "client_tool_call": {
          this.recordRealtimeToolCall(event, "client_tool_call");
          // Respond with client_tool_result so the agent doesn't hang waiting.
          // Vent is observation-only — we acknowledge with an empty success result.
          const toolPayload = resolveElevenLabsRealtimeToolPayload(event, "client_tool_call");
          const callId = toolPayload?.tool_call_id ?? toolPayload?.toolCallId ?? event.tool_call_id ?? event.toolCallId;
          if (callId && this.room?.localParticipant) {
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
          this.recordRealtimeToolCall(event, "mcp_tool_call");
          break;
        }

        case "agent_tool_request": {
          this.recordRealtimeToolCall(event, "agent_tool_request");
          break;
        }

        case "agent_tool_response": {
          this.finalizeRealtimeToolCall(event);
          break;
        }

        case "vad_score": {
          this.appendRealtimeProviderMetadataListItem("elevenlabs_vad_scores", event);
          break;
        }

        case "agent_response_metadata": {
          this.appendRealtimeProviderMetadataListItem("elevenlabs_agent_response_metadata", event);
          break;
        }

        case "internal_turn_probability": {
          this.appendRealtimeProviderMetadataListItem("elevenlabs_internal_turn_probabilities", event);
          break;
        }

        case "internal_tentative_agent_response": {
          this.appendRealtimeProviderMetadataListItem("elevenlabs_internal_tentative_agent_responses", event);
          break;
        }

        case "agent_chat_response_part": {
          this.appendRealtimeProviderMetadataListItem("elevenlabs_agent_chat_response_parts", event);
          break;
        }

        case "guardrail_triggered": {
          this.recordRealtimeProviderWarning({
            message: firstString(
              firstRecord(event.guardrail_triggered_event)?.message,
              firstRecord(event.guardrail_triggered_event)?.guardrail_name,
              event.message,
              event.guardrail_name,
            ) ?? "ElevenLabs guardrail triggered",
            code: firstString(
              firstRecord(event.guardrail_triggered_event)?.code,
              firstRecord(event.guardrail_triggered_event)?.guardrail_name,
              event.code,
            ) ?? "guardrail_triggered",
            detail: sanitizeRealtimeDetail(event),
          });
          this.appendRealtimeProviderMetadataListItem("elevenlabs_guardrail_events", event);
          break;
        }

        case "client_error": {
          const nested = firstRecord(event.client_error_event);
          this.recordRealtimeProviderWarning({
            message: firstString(nested?.message, nested?.error, event.message, event.error) ?? "ElevenLabs client error",
            code: firstString(nested?.code, nested?.type, event.code, event.type) ?? "client_error",
            detail: sanitizeRealtimeDetail(event),
          });
          this.appendRealtimeProviderMetadataListItem("elevenlabs_client_errors", event);
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

  private recordRealtimeToolCall(event: Record<string, unknown>, eventType: string): void {
    const toolEvent = extractElevenLabsRealtimeToolEvent(event, eventType);
    if (!toolEvent?.name) return;

    const index = this.upsertRealtimeToolCall(toolEvent);
    if (index == null) return;

    const existing = this.realtimeToolCalls[index];
    if (!existing) return;

    const isTerminal = toolEvent.state === "success" || toolEvent.state === "failure";
    if (isTerminal) {
      existing.successful = toolEvent.state === "success";
      if (toolEvent.result !== undefined) {
        existing.result = toolEvent.result;
      } else if (toolEvent.error) {
        existing.result = toolEvent.error;
      }
      if (existing.timestamp_ms != null && existing.latency_ms == null) {
        existing.latency_ms = Math.max(0, Date.now() - this.connectTimestamp - existing.timestamp_ms);
      }
      this.markToolCallComplete(toolEvent.toolCallId);
    } else {
      this.markToolCallPending(toolEvent.toolCallId);
    }
  }

  private finalizeRealtimeToolCall(event: Record<string, unknown>): void {
    const toolEvent = extractElevenLabsRealtimeToolEvent(event, "agent_tool_response");
    if (!toolEvent?.name && !toolEvent?.toolCallId) return;

    const index = this.upsertRealtimeToolCall(toolEvent);
    if (index == null) return;

    const existing = this.realtimeToolCalls[index];
    if (!existing) return;

    if (toolEvent.result !== undefined) {
      existing.result = toolEvent.result;
    } else if (toolEvent.error) {
      existing.result = toolEvent.error;
    }

    if (toolEvent.successful != null) {
      existing.successful = toolEvent.successful;
    }

    if (existing.timestamp_ms != null && existing.latency_ms == null) {
      existing.latency_ms = Math.max(0, Date.now() - this.connectTimestamp - existing.timestamp_ms);
    }

    this.markToolCallComplete(toolEvent.toolCallId);
  }

  private markToolCallPending(toolCallId: string | undefined): void {
    if (!toolCallId || this.pendingToolCallIds.has(toolCallId)) return;
    const wasEmpty = this.pendingToolCallIds.size === 0;
    this.pendingToolCallIds.add(toolCallId);
    if (wasEmpty) this.emit("toolCallActive", true);
  }

  private markToolCallComplete(toolCallId: string | undefined): void {
    if (!toolCallId || !this.pendingToolCallIds.has(toolCallId)) return;
    this.pendingToolCallIds.delete(toolCallId);
    if (this.pendingToolCallIds.size === 0) this.emit("toolCallActive", false);
  }

  private upsertRealtimeToolCall(toolEvent: ElevenLabsRealtimeToolEvent): number | null {
    const timestampMs = Date.now() - this.connectTimestamp;
    const toolCallId = toolEvent.toolCallId;
    if (toolCallId) {
      const existingIndex = this.realtimeToolCallIndexById.get(toolCallId);
      if (existingIndex != null) {
        const existing = this.realtimeToolCalls[existingIndex];
        if (!existing) return existingIndex;

        if (toolEvent.name) {
          existing.name = toolEvent.name;
        }
        if (toolEvent.arguments) {
          existing.arguments = toolEvent.arguments;
        }
        if (toolEvent.providerToolType && !existing.provider_tool_type) {
          existing.provider_tool_type = toolEvent.providerToolType;
        }
        return existingIndex;
      }
    }

    if (!toolEvent.name) return null;

    this.realtimeToolCalls.push({
      name: toolEvent.name,
      arguments: toolEvent.arguments ?? {},
      provider_tool_type: toolEvent.providerToolType,
      timestamp_ms: timestampMs,
    });
    const index = this.realtimeToolCalls.length - 1;
    if (toolCallId) {
      this.realtimeToolCallIndexById.set(toolCallId, index);
    }
    return index;
  }

  private appendRealtimeProviderMetadataListItem(key: string, value: unknown): void {
    const sanitized = sanitizeRealtimeDetail(value);
    if (sanitized == null) return;
    const existing = this.realtimeProviderMetadata[key];
    if (Array.isArray(existing)) {
      existing.push(sanitized);
      return;
    }
    this.realtimeProviderMetadata[key] = [sanitized];
  }

  private recordRealtimeProviderWarning(warning: ProviderWarning): void {
    const compacted = compactProviderWarning(warning);
    if (!compacted) return;
    this.realtimeProviderWarnings = dedupeProviderWarnings([
      ...this.realtimeProviderWarnings,
      compacted,
    ]);
  }

  private conversationData?: Promise<Record<string, unknown> | null>;

  /** One shared fetch per call. ElevenLabs reports "processing" until the conversation is final. */
  private fetchConversation(): Promise<Record<string, unknown> | null> {
    if (!this.conversationId) return Promise.resolve(null);
    const conversationId = this.conversationId;
    this.conversationData ??= pollUntilReady(
      "elevenlabs-postcall",
      async () => await this.client.conversationalAi.conversations.get(conversationId) as unknown as Record<string, unknown>,
      (data) => data.status === "done" || data.status === "failed",
    ).then((data) => (this.cachedConversation = data));
    return this.conversationData;
  }


  private parseToolCalls(data: Record<string, unknown>): ObservedToolCall[] {
    const messages = data.transcript as Array<Record<string, unknown>> | undefined;
    if (!messages) return [];

    const toolCalls: ObservedToolCall[] = [];

    // Build result map keyed by tool_call_id
    const resultMap = new Map<string, {
      result?: unknown;
      error?: string;
      time?: number;
      latencyMs?: number;
      providerToolType?: string;
    }>();
    for (const msg of messages) {
      const toolResults = firstArrayOfRecords(msg.toolResults, msg.tool_results);
      if (toolResults) {
        for (const tr of toolResults) {
          const id = firstString(tr.toolCallId, tr.tool_call_id, tr.requestId, tr.request_id);
          if (id) {
            resultMap.set(id, {
              result: firstDefined(tr.result, tr.resultValue, tr.result_value),
              error: firstString(
                tr.error,
                firstBoolean(tr.isError, tr.is_error) === true ? "tool_error" : undefined,
              ),
              time: firstNumber(msg.timeInCallSecs, msg.time_in_call_secs),
              latencyMs: scaleSecondsToMs(firstNumber(tr.toolLatencySecs, tr.tool_latency_secs)),
              providerToolType: firstString(tr.type),
            });
          }
        }
      }
    }

    for (const msg of messages) {
      const tcs = firstArrayOfRecords(msg.toolCalls, msg.tool_calls);
      if (!tcs) continue;

      for (const tc of tcs) {
        const name = firstString(tc.name, tc.toolName, tc.tool_name);
        if (!name) continue;
        const params = firstRecord(tc.params, tc.parameters)
          ?? parseJsonRecord(firstString(tc.paramsAsJson, tc.params_as_json))
          ?? {};
        const toolCallId = firstString(tc.toolCallId, tc.tool_call_id, tc.requestId, tc.request_id);
        const resultEntry = toolCallId ? resultMap.get(toolCallId) : undefined;
        const timestampMs = scaleSecondsToMs(firstNumber(msg.timeInCallSecs, msg.time_in_call_secs));
        const resultTimeMs = scaleSecondsToMs(resultEntry?.time);

        toolCalls.push({
          name,
          arguments: params,
          result: resultEntry?.result,
          successful: resultEntry ? !resultEntry.error : undefined,
          provider_tool_type: firstString(tc.type, resultEntry?.providerToolType),
          timestamp_ms: timestampMs,
          latency_ms:
            resultEntry?.latencyMs
              ?? (
            timestampMs != null && resultTimeMs != null
              ? resultTimeMs - timestampMs
              : undefined
          ),
        });
      }
    }

    return toolCalls;
  }

  private startReadingTrack(track: RemoteTrack): void {
    const sampleRate = ElevenLabsAudioChannel.LIVEKIT_SAMPLE_RATE;
    const stream = new AudioStream(track, sampleRate, 1);
    const reader = stream.getReader();

    const readLoop = async () => {
      try {
        while (this.collecting) {
          const { value: frame, done } = await reader.read();
          if (done || !frame) break;

          const frameBuffer = Buffer.from(
            frame.data.buffer,
            frame.data.byteOffset,
            frame.data.byteLength
          );
          this._stats.bytesReceived += frameBuffer.length;
          // Resample from LiveKit 48kHz → 24kHz for consumers
          const pcm24k = resample(frameBuffer, sampleRate, 24000);
          this.captureAgentAudio(pcm24k, performance.now() - this._connectMonotonicMs);
          this.emit("audio", pcm24k);
        }
      } catch (err) {
        if (err instanceof Error) {
          this._stats.errorEvents.push(err.message);
        }
      }
    };

    readLoop();
  }
}

export function extractElevenLabsComponentTimings(data: Record<string, unknown> | null | undefined): ComponentLatency[] {
  const transcript = data?.transcript as Array<Record<string, unknown>> | undefined;
  if (!transcript) return [];

  const timings: ComponentLatency[] = [];
  for (const msg of transcript) {
    if (msg.role !== "agent") continue;
    const turnMetrics = msg.conversationTurnMetrics as Record<string, unknown> | undefined;
    const metrics = turnMetrics?.metrics as Record<string, { elapsedTime?: number }> | undefined;
    if (!metrics) continue;

    let sttMs: number | undefined;
    let llmMs: number | undefined;
    let ttsMs: number | undefined;
    for (const [key, val] of Object.entries(metrics)) {
      if (val.elapsedTime == null) continue;
      const ms = val.elapsedTime * 1000;
      const k = key.toLowerCase();
      if ((k.includes("asr") || k.includes("stt")) && sttMs == null) {
        sttMs = ms;
      } else if (k.includes("llm") && k.includes("ttfb") && llmMs == null) {
        llmMs = ms;
      } else if (k.includes("tts") && ttsMs == null) {
        ttsMs = ms;
      }
    }

    if (sttMs != null || llmMs != null || ttsMs != null) {
      timings.push({ stt_ms: sttMs, llm_ms: llmMs, tts_ms: ttsMs });
    }
  }
  return timings;
}

function compactUnknownRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value != null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function compactRealtimeProviderMetadata(
  metadata: Record<string, unknown[]>,
): Record<string, unknown> | undefined {
  const entries = Object.entries(metadata).filter(([, value]) => Array.isArray(value) && value.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

function firstDefined<T>(...values: T[]): T | undefined {
  for (const value of values) {
    if (value != null) {
      return value;
    }
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function sanitizeRealtimeDetail(value: unknown): unknown {
  if (value == null) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function firstArrayOfRecords(...values: unknown[]): Array<Record<string, unknown>> | undefined {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
    }
  }
  return undefined;
}

function parseJsonRecord(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function scaleSecondsToMs(value: number | undefined): number | undefined {
  return value != null ? value * 1000 : undefined;
}

/**
 * Extract LLM token usage from ElevenLabs conversation data.
 *
 * Sources (checked in order of preference):
 *   1. metadata.charging.llm_usage.irreversible_generation.model_usage.<model>
 *   2. Per-turn transcript[].llm_usage.model_usage.<model>
 *
 * Both shapes expose { input: { tokens }, output_total: { tokens } } per model.
 */
function extractElevenLabsUsage(data: Record<string, unknown>): UsageEntry[] | undefined {
  const entries: UsageEntry[] = [];

  // ── Source 1: aggregated charging data ────────────────────────
  const meta = data.metadata as Record<string, unknown> | undefined;
  const charging = meta?.charging as Record<string, unknown> | undefined;
  const llmUsage = charging?.llm_usage as Record<string, unknown> | undefined;
  const irrevGen = (llmUsage?.irreversible_generation ?? llmUsage) as Record<string, unknown> | undefined;
  const aggregatedModelUsage = irrevGen?.model_usage as Record<string, unknown> | undefined;

  if (aggregatedModelUsage) {
    for (const [model, usage] of Object.entries(aggregatedModelUsage)) {
      const u = usage as Record<string, unknown> | undefined;
      if (!u) continue;
      const inputTokens = (u.input as Record<string, unknown> | undefined)?.tokens as number | undefined;
      const outputTokens = (u.output_total as Record<string, unknown> | undefined)?.tokens as number | undefined;
      if (inputTokens != null || outputTokens != null) {
        entries.push({
          type: "llm_usage",
          provider: "elevenlabs",
          model,
          input_tokens: inputTokens ?? undefined,
          output_tokens: outputTokens ?? undefined,
        });
      }
    }
  }

  // If we got aggregated data, prefer that over per-turn sums.
  if (entries.length > 0) return entries;

  // ── Source 2: per-turn transcript entries ─────────────────────
  const transcript = data.transcript as Array<Record<string, unknown>> | undefined;
  if (!transcript) return undefined;

  // Accumulate across turns keyed by model name.
  const acc = new Map<string, { input: number; output: number }>();

  for (const turn of transcript) {
    const turnLlm = turn.llm_usage as Record<string, unknown> | undefined;
    const turnModelUsage = turnLlm?.model_usage as Record<string, unknown> | undefined;
    if (!turnModelUsage) continue;

    for (const [model, usage] of Object.entries(turnModelUsage)) {
      const u = usage as Record<string, unknown> | undefined;
      if (!u) continue;
      const inputTokens = (u.input as Record<string, unknown> | undefined)?.tokens as number | undefined;
      const outputTokens = (u.output_total as Record<string, unknown> | undefined)?.tokens as number | undefined;
      if (inputTokens == null && outputTokens == null) continue;

      const prev = acc.get(model) ?? { input: 0, output: 0 };
      acc.set(model, {
        input: prev.input + (inputTokens ?? 0),
        output: prev.output + (outputTokens ?? 0),
      });
    }
  }

  for (const [model, totals] of acc) {
    entries.push({
      type: "llm_usage",
      provider: "elevenlabs",
      model,
      input_tokens: totals.input || undefined,
      output_tokens: totals.output || undefined,
    });
  }

  return entries.length > 0 ? entries : undefined;
}

function extractElevenLabsProviderWarnings(
  meta: Record<string, unknown> | undefined,
): ProviderWarning[] | undefined {
  if (!meta) return undefined;

  const warnings: ProviderWarning[] = [];
  const rawWarnings = meta.warnings;
  if (Array.isArray(rawWarnings)) {
    for (const item of rawWarnings) {
      if (typeof item === "string" && item.length > 0) {
        warnings.push({ message: item });
        continue;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      const warning = compactProviderWarning({
        message: firstString(record.message, record.warning, record.text),
        code: firstString(record.code, record.type),
        detail: record.detail ?? record.data,
      });
      if (warning) warnings.push(warning);
    }
  } else if (typeof rawWarnings === "string" && rawWarnings.length > 0) {
    warnings.push({ message: rawWarnings });
  }

  const error = meta.error;
  if (typeof error === "string" && error.length > 0) {
    warnings.push({ message: error, code: "provider_error" });
  } else if (error && typeof error === "object" && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    const warning = compactProviderWarning({
      message: firstString(record.message, record.error),
      code: firstString(record.code, record.type) ?? "provider_error",
      detail: record.detail ?? record.data ?? record,
    });
    if (warning) warnings.push(warning);
  }

  return warnings.length > 0 ? dedupeProviderWarnings(warnings) : undefined;
}

function compactProviderWarning(warning: ProviderWarning): ProviderWarning | undefined {
  const entries = Object.entries(warning).filter(([, value]) => value != null);
  return entries.length > 0 ? Object.fromEntries(entries) as ProviderWarning : undefined;
}

function dedupeProviderWarnings(warnings: ProviderWarning[]): ProviderWarning[] {
  const unique = new Map<string, ProviderWarning>();
  for (const warning of warnings) {
    const normalized = compactProviderWarning(warning);
    if (!normalized) continue;
    unique.set(JSON.stringify(normalized), normalized);
  }
  return [...unique.values()];
}

interface ElevenLabsRealtimeToolEvent {
  name?: string;
  toolCallId?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  successful?: boolean;
  providerToolType?: string;
  state?: string;
}

function extractElevenLabsRealtimeToolEvent(
  event: Record<string, unknown>,
  eventType: string,
): ElevenLabsRealtimeToolEvent | null {
  const nested = resolveElevenLabsRealtimeToolPayload(event, eventType);
  if (!nested) return null;

  const toolCallId = firstString(
    nested.tool_call_id,
    nested.toolCallId,
    event.tool_call_id,
    event.toolCallId,
  );

  const name = firstString(
    nested.tool_name,
    nested.name,
    event.tool_name,
    event.name,
  );

  const argumentsRecord = firstRecord(
    nested.parameters,
    nested.params,
    nested.arguments,
    event.parameters,
    event.params,
    event.arguments,
  );

  const providerToolType = eventType === "mcp_tool_call"
    ? "mcp"
    : firstString(
      nested.tool_type,
      nested.type,
      event.tool_type,
    );

  const state = firstString(nested.state, event.state);
  const error = firstString(
    nested.error,
    event.error,
    firstBoolean(nested.is_error, event.is_error) === true ? "tool_error" : undefined,
  );
  const result = firstDefined(
    nested.result,
    nested.tool_result,
    nested.output,
    nested.response,
    event.result,
    event.tool_result,
    event.output,
    event.response,
  );

  return {
    name,
    toolCallId,
    arguments: argumentsRecord,
    result,
    error,
    successful: firstBoolean(
      nested.is_error,
      event.is_error,
    ) != null
      ? !firstBoolean(nested.is_error, event.is_error)
      : undefined,
    providerToolType,
    state,
  };
}

function resolveElevenLabsRealtimeToolPayload(
  event: Record<string, unknown>,
  eventType: string,
): Record<string, unknown> | undefined {
  switch (eventType) {
    case "client_tool_call":
      return firstRecord(event.client_tool_call, event.client_tool_call_event);
    case "mcp_tool_call":
      return firstRecord(event.mcp_tool_call, event.mcp_tool_call_event);
    case "agent_tool_request":
      return firstRecord(event.agent_tool_request, event.agent_tool_request_event);
    case "agent_tool_response":
      return firstRecord(event.agent_tool_response, event.agent_tool_response_event);
    default:
      return undefined;
  }
}

export function extractElevenLabsTransfers(data: Record<string, unknown>): CallTransfer[] | undefined {
  const messages = data.transcript as Array<Record<string, unknown>> | undefined;
  if (!messages) return undefined;

  const resultMap = new Map<string, { result?: unknown; error?: string; time?: number }>();
  for (const msg of messages) {
    const toolResults = firstArrayOfRecords(msg.toolResults, msg.tool_results);
    if (!toolResults) continue;
    for (const tr of toolResults) {
      const id = firstString(tr.toolCallId, tr.tool_call_id, tr.requestId, tr.request_id);
      if (!id) continue;
      resultMap.set(id, {
        result: firstDefined(tr.result, tr.resultValue, tr.result_value),
        error: firstString(
          tr.error,
          firstBoolean(tr.isError, tr.is_error) === true ? "tool_error" : undefined,
        ),
        time: firstNumber(msg.timeInCallSecs, msg.time_in_call_secs),
      });
    }
  }

  const transfers: CallTransfer[] = [];

  for (const msg of messages) {
    const timestampMs = scaleSecondsToMs(firstNumber(msg.timeInCallSecs, msg.time_in_call_secs));
    const toolCalls = firstArrayOfRecords(msg.toolCalls, msg.tool_calls);
    if (!toolCalls) continue;

    for (const toolCall of toolCalls) {
      const name = firstString(toolCall.name, toolCall.toolName, toolCall.tool_name);
      if (!name || !isElevenLabsTransferTool(name)) continue;
      const params = firstRecord(toolCall.params, toolCall.parameters)
        ?? parseJsonRecord(firstString(toolCall.paramsAsJson, toolCall.params_as_json));
      const toolCallId = firstString(
        toolCall.toolCallId,
        toolCall.tool_call_id,
        toolCall.requestId,
        toolCall.request_id,
      );
      const resultEntry = toolCallId ? resultMap.get(toolCallId) : undefined;
      const transfer: CallTransfer = {
        type: name,
        destination: extractElevenLabsTransferDestination(params),
        status: resolveElevenLabsTransferStatus(resultEntry),
        sources: resultEntry ? ["tool_call", "platform_metadata"] : ["tool_call"],
      };
      if (timestampMs != null) {
        transfer.timestamp_ms = timestampMs;
      }
      transfers.push(transfer);
    }
  }

  return transfers.length > 0 ? transfers : undefined;
}

function isElevenLabsTransferTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "transfer_to_number"
    || normalized === "transfer_to_human"
    || normalized === "agent_transfer";
}

function extractElevenLabsTransferDestination(params: Record<string, unknown> | undefined): string | undefined {
  if (!params) return undefined;
  if (typeof params.transfer_number === "string") return params.transfer_number;
  if (typeof params.transferNumber === "string") return params.transferNumber;
  if (typeof params.destination === "string") return params.destination;

  const transferDestination = params.transfer_destination;
  if (transferDestination && typeof transferDestination === "object") {
    const value = transferDestination as Record<string, unknown>;
    if (typeof value.phone_number === "string") return value.phone_number;
    if (typeof value.sip_uri === "string") return value.sip_uri;
    if (typeof value.transfer_number === "string") return value.transfer_number;
  }

  return undefined;
}

function resolveElevenLabsTransferStatus(
  resultEntry: { result?: unknown; error?: string } | undefined,
): CallTransfer["status"] {
  if (!resultEntry) return "attempted";

  const errorText = resultEntry.error?.trim().toLowerCase();
  if (errorText) {
    if (errorText.includes("cancel")) return "cancelled";
    return "failed";
  }

  const status = extractElevenLabsResultStatus(resultEntry.result);
  if (status) return status;

  return "attempted";
}

function extractElevenLabsResultStatus(result: unknown): CallTransfer["status"] | null {
  if (result == null) return null;
  if (typeof result === "boolean") return result ? "completed" : "failed";
  if (typeof result === "string") {
    return classifyElevenLabsResultToken(result);
  }
  if (typeof result !== "object") return null;

  const record = result as Record<string, unknown>;
  for (const key of ["status", "outcome", "result", "state"]) {
    const value = record[key];
    if (typeof value === "string") {
      const classified = classifyElevenLabsResultToken(value);
      if (classified) return classified;
    }
  }

  return null;
}

function classifyElevenLabsResultToken(token: string): CallTransfer["status"] | null {
  const normalized = token.trim().toLowerCase();
  if (normalized === "completed" || normalized === "success" || normalized === "succeeded" || normalized === "ok") {
    return "completed";
  }
  if (normalized === "cancelled" || normalized === "canceled") {
    return "cancelled";
  }
  if (normalized === "failed" || normalized === "error") {
    return "failed";
  }
  return null;
}
