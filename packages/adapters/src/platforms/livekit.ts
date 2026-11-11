/**
 * WebRTC Audio Channel (LiveKit)
 *
 * Joins a LiveKit room, publishes audio via AudioSource, and
 * receives agent audio via AudioStream. Handles 24kHz <-> 48kHz
 * resampling internally (LiveKit uses 48kHz by default).
 *
 * Captures LiveKit agent observability data automatically broadcast to the room:
 *   - Agent state transitions (lk.agent.state) for component latency estimation
 *   - Transcription streams (lk.transcription) for platform STT transcripts
 *   - Tool call events via DataChannel on topic "vent:tool-calls"
 *   - Optional inside-agent metadata via custom "vent:*" topics
 *   - Disconnect reason for call metadata
 *
 * Supports explicit agent dispatch via AgentDispatchClient when agentName is set.
 */

import {
  RoomEvent,
  TrackKind,
  ParticipantKind,
  DisconnectReason,
  IceTransportType,
  ContinualGatheringPolicy,
  type Participant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "@livekit/rtc-node";
import { RoomAgentDispatch, RoomConfiguration } from "@livekit/protocol";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import type { ObservedToolCall, CallMetadata, ComponentLatency } from "@vent/shared";
import { CONNECT_TIMEOUT_MS, type PlatformUtterance } from "../shared/audio-channel.js";
import { CALLER_IDENTITY, LiveKitRoomChannel } from "../shared/livekit-room.js";
import { compactStringRecord } from "../shared/record-utils.js";
import {
  VENT_EVENTS,
  mergeCallMetadata,
  observedToolCall,
  ventEventMetadata,
  type VentToolCallEvent,
} from "../shared/vent-events.js";

interface LiveKitMetricsEvent {
  type?: "vent:metrics";
  event?: string;
  metrics?: Record<string, unknown>;
  timestamp_ms?: number;
}

/** A `conversation_item_added` event: the JS SDK names fields in camelCase, Python in snake_case. */
interface LiveKitConversationItemEvent {
  item: Record<string, unknown>;
}

/** Per-turn state from LiveKit agent state transitions + transcription streams */
interface LiveKitTurnTiming {
  /** Agent state → "speaking" (TTS started) */
  speakingAt?: number;
  /** User STT transcript from lk.transcription */
  userTranscript?: string;
  /** Agent LLM text from lk.transcription */
  agentTranscript?: string;
}

interface LiveKitAgentStateTransition {
  nextLastAgentState: string;
  emitPlatformSpeechStart: boolean;
  emitPlatformEndOfTurn: boolean;
  /** Set to true when entering `thinking` mid-response (tool call / LLM work),
   *  false when leaving it. null means no change. */
  emitToolCallActive: boolean | null;
}

interface LiveKitMetricTiming {
  speechId?: string;
  timing: ComponentLatency;
}

const LIVEKIT_TRANSCRIPTION_TOPIC = "lk.transcription";
const LIVEKIT_AGENT_STATE_ATTR = "lk.agent.state";

function applyLiveKitAgentStateChange(
  previousState: string | null,
  turn: LiveKitTurnTiming | undefined,
  agentState: string,
  now: number,
): LiveKitAgentStateTransition {
  switch (agentState) {
    case "thinking":
      return {
        nextLastAgentState: agentState,
        emitPlatformSpeechStart: false,
        emitPlatformEndOfTurn: false,
        emitToolCallActive: previousState === "speaking" ? true : null,
      };

    case "speaking":
      if (turn && !turn.speakingAt) {
        turn.speakingAt = now;
      }
      return {
        nextLastAgentState: agentState,
        emitPlatformSpeechStart: previousState !== "speaking",
        emitPlatformEndOfTurn: false,
        emitToolCallActive: previousState === "thinking" ? false : null,
      };

    case "listening": {
      const wasSpeaking = previousState === "speaking" || !!turn?.speakingAt;
      return {
        nextLastAgentState: agentState,
        emitPlatformSpeechStart: false,
        emitPlatformEndOfTurn: wasSpeaking && previousState !== "listening",
        emitToolCallActive: previousState === "thinking" ? false : null,
      };
    }

    default:
      return {
        nextLastAgentState: agentState,
        emitPlatformSpeechStart: false,
        emitPlatformEndOfTurn: false,
        emitToolCallActive: null,
      };
  }
}

interface WebRtcAudioChannelConfig {
  livekitUrl: string;
  apiKey: string;
  apiSecret: string;
  roomName: string;
  /** Optional agent name for explicit dispatch (required if agent uses agent_name registration) */
  agentName?: string;
}

export class WebRtcAudioChannel extends LiveKitRoomChannel {
  /** LiveKit emits platformEndOfTurn via agent state transitions. */
  hasPlatformEndOfTurn = true;

  private config: WebRtcAudioChannelConfig;
  private toolCalls: ObservedToolCall[] = [];
  private connectTimestamp = 0;

  // Component latency tracking from agent state transitions + transcriptions
  private turnTimings: LiveKitTurnTiming[] = [];
  private currentTurnIndex = -1;
  /** Agent LLM text before the caller's first turn */
  private greetingTranscript = "";
  private agentIdentity: string | null = null;
  private disconnectReasonStr: string | null = null;
  private roomSid: string | null = null;
  private lastAgentState: string | null = null;

  // Receive-path state, surfaced via getReceiveDiagnostics() when a collection
  // times out with no speech detected.
  private rxTracks = 0;
  private rxLastAssistantItemAt: number | null = null;
  private rxLastAgentStateAt: number | null = null;
  // Primary track lock for multi-track agents — see Retell adapter for the
  // detailed rationale. Defaults null (no lock); first track to exceed the
  // amplitude threshold becomes primary, others are dropped.
  private primaryAgentTrackSid: string | null = null;
  // Guards startReadingTrack against being called twice for the same track —
  // can happen when both the pre-existing-participants fast-path and the
  // TrackSubscribed listener fire for the same publication. Two AudioStream
  // readers on one track compete for frames and corrupt the receive path.
  private startedTrackSids = new Set<string>();
  private static readonly PRIMARY_TRACK_MEAN_ABS_THRESHOLD = 100;
  private callMetadata: CallMetadata = { platform: "livekit" };
  private livekitMetricTimings: LiveKitMetricTiming[] = [];
  private livekitMetricTimingIndexBySpeechId = new Map<string, number>();
  private toolCallFingerprints = new Set<string>();

  // Segment-to-turn anchoring: lock each STT segment to the turn that was
  // active when the segment was first observed (interim or final).
  private segmentTurnMap = new Map<string, number>();

  constructor(config: WebRtcAudioChannelConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();
    const token = new AccessToken(
      this.config.apiKey,
      this.config.apiSecret,
      { identity: CALLER_IDENTITY }
    );
    token.addGrant({
      roomJoin: true,
      room: this.config.roomName,
      roomCreate: true,
      canPublish: true,
      canSubscribe: true,
    });

    // Token-based dispatch: agent is dispatched atomically when the room is
    // created, eliminating the race between participant join and API dispatch.
    if (this.config.agentName) {
      token.roomConfig = new RoomConfiguration({
        agents: [
          new RoomAgentDispatch({ agentName: this.config.agentName }),
        ],
      });
    }

    const jwt = await token.toJwt();

    // On Fly.io (and other containerized environments), direct UDP is unreliable
    // because containers sit behind WireGuard tunnels and HTTP proxies. Force
    // TURN relay so LiveKit uses TURN/TLS (TCP:443) which works through any proxy.
    const isFlyIo = !!process.env["FLY_MACHINE_ID"];
    const room = await this.joinRoom(this.config.livekitUrl, jwt, isFlyIo
      ? {
          iceTransportType: IceTransportType.TRANSPORT_RELAY,
          continualGatheringPolicy: ContinualGatheringPolicy.GATHER_CONTINUALLY,
          iceServers: [],
        }
      : undefined);
    this.connectTimestamp = Date.now();
    // The room SID keys the session's Agent Insights page in LiveKit Cloud.
    void room.getSid().then((sid) => { this.roomSid = sid; }, () => {});

    // ── Vent observability via DataChannel ─────────────────────
    room.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
        if (!this.isObservabilityParticipant(participant) || !topic) return;
        this.handleObservabilityData(payload, topic);
      }
    );

    // ── Agent state transitions (lk.agent.state) ──────────────
    room.on(
      RoomEvent.ParticipantAttributesChanged,
      (changedAttributes: Record<string, string>, participant: Participant) => {
        const agentState = changedAttributes[LIVEKIT_AGENT_STATE_ATTR];
        if (!agentState) return;

        // Use ParticipantKind for definitive agent identification
        if (participant.kind === ParticipantKind.AGENT) {
          this.agentIdentity = participant.identity;
        } else if (this.agentIdentity && participant.identity !== this.agentIdentity) {
          return; // Ignore non-agent participants
        }

        this.handleAgentStateChange(agentState, Date.now());
      }
    );

    // ── Transcription streams (lk.transcription) ──────────────
    room.registerTextStreamHandler(
      LIVEKIT_TRANSCRIPTION_TOPIC,
      async (reader, participantInfo) => {
        const isUser = participantInfo.identity === CALLER_IDENTITY;
        const turn = this.currentTurnIndex >= 0 ? this.turnTimings[this.currentTurnIndex] : undefined;

        if (isUser) {
          // Segment-anchored transcript assignment.
          // Each STT utterance has a unique lk.segment_id shared across
          // interim and final streams. The first stream (interim) arrives
          // while the correct turn is still active. The final stream may
          // arrive later during a different turn. We lock the segment to
          // the turn on first sight, then assign the final text there.
          // LiveKit agents set lk.segment_id on every transcription stream.
          const segmentId = reader.info?.attributes?.["lk.segment_id"] ?? "";
          const isFinal = reader.info?.attributes?.["lk.transcription_final"] === "true";

          // Lock segment to current turn on first observation
          if (!this.segmentTurnMap.has(segmentId)) {
            this.segmentTurnMap.set(segmentId, this.currentTurnIndex);
          }

          if (!isFinal) return; // Skip interim — only need text from final

          const anchoredTurnIdx = this.segmentTurnMap.get(segmentId)!;
          const anchoredTurn = anchoredTurnIdx >= 0 ? this.turnTimings[anchoredTurnIdx] : undefined;
          const text = await reader.readAll();
          if (anchoredTurn && text) {
            anchoredTurn.userTranscript = anchoredTurn.userTranscript
              ? `${anchoredTurn.userTranscript} ${text}`
              : text;
          }
        } else {
          // Agent transcription: the LLM's text.
          let text = "";
          for await (const chunk of reader) text += chunk;
          text = text.trim();
          if (!text) return;
          if (turn) turn.agentTranscript = turn.agentTranscript ? `${turn.agentTranscript} ${text}` : text;
          else this.greetingTranscript = this.greetingTranscript ? `${this.greetingTranscript} ${text}` : text;
        }
      }
    );

    // ── Disconnect reason capture ─────────────────────────────
    room.once(RoomEvent.Disconnected, (reason: DisconnectReason) => {
      this.handleRoomDisconnected(reason);
    });

    // ── Subscribe to remote audio tracks ──────────────────────
    // Attached BEFORE the `await publishTrack` below so we don't lose the
    // agent's TrackSubscribed event during that async window. Prior placement
    // (after publishTrack + the pre-existing-participants fast-path) created a
    // race where the agent could publish during the await with no listener
    // attached, the event would be dropped, and the receive path would never
    // start reading the track — manifesting as an empty transcript on the
    // second of two parallel calls.
    room.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (participant.kind === ParticipantKind.AGENT && !this.agentIdentity) {
          this.agentIdentity = participant.identity;
        }
        if (pub.kind === TrackKind.KIND_AUDIO) {
          console.log(
            `[livekit] TrackSubscribed audio participant=${participant.identity} kind=${participant.kind} trackSid=${pub.sid}`
          );
          this.startReadingTrack(track, participant.identity, participant.kind);
        }
      }
    );

    // ── Audio source for publishing ───────────────────────────
    await this.publishCallerTrack();

    // ── Comfort noise — keep Opus codec warm ────────────────
    // Without continuous audio frames, Opus enters DTX (silence) mode.
    // When real speech arrives minutes later, the codec ramps bitrate
    // linearly from 0 → 40kbps over 20s — the agent's VAD misses it.
    // Low-level white noise forces Opus to maintain a baseline bitrate.
    this.startComfortNoise();

    // Subscribe to existing remote audio tracks
    for (const participant of room.remoteParticipants.values()) {
      console.log(
        `[livekit] pre-existing remote participant identity=${participant.identity} kind=${participant.kind} tracks=${participant.trackPublications.size}`
      );
      if (participant.kind === ParticipantKind.AGENT) {
        this.agentIdentity = participant.identity;
      }
      for (const pub of participant.trackPublications.values()) {
        if (pub.track && pub.kind === TrackKind.KIND_AUDIO) {
          console.log(
            `[livekit] subscribing to pre-existing audio track participant=${participant.identity} kind=${participant.kind} trackSid=${pub.sid}`
          );
          this.startReadingTrack(pub.track as RemoteTrack, participant.identity, participant.kind);
        }
      }
    }

    // Wait for the agent's audio track to be published/subscribed — matches
    // the canonical pattern used by Retell/ElevenLabs/Pipecat LiveKit
    // transports. We don't gate on agent.state because LiveKit Agents
    // publishes a single persistent track at session.start() and transitions
    // through "initializing → listening → speaking" — "listening" only
    // fires AFTER the greeting finishes, which means gating on it hides the
    // greeting and opens a first-listener race in our early-audio buffer.
    // agent.state transitions are still used for per-turn EOT elsewhere.
    const agent = await this.waitForAgentTrack((participant) => participant.kind === ParticipantKind.AGENT);
    if (!agent) {
      throw new Error(
        `LiveKit agent did not publish an audio track in room "${this.config.roomName}" within ${CONNECT_TIMEOUT_MS / 1000}s. ` +
        `Ensure your agent is running and connected to ${this.config.livekitUrl}. ` +
        `If your agent uses agent_name in WorkerOptions, set "agent_name" in the platform config.`
      );
    }
    this.agentIdentity = agent.identity;

    this._stats.connectLatencyMs = Date.now() - connectStart;
  }

  override sendAudio(pcm: Buffer): void {
    if (!this.publishing) return;

    // Track turn timing
    this.currentTurnIndex++;
    this.turnTimings[this.currentTurnIndex] = {};
    this.lastAgentState = null;

    super.sendAudio(pcm);
  }

  async disconnect(): Promise<void> {
    try {
      this.room?.unregisterTextStreamHandler(LIVEKIT_TRANSCRIPTION_TOPIC);
    } catch {
      // May not be registered if connect() failed partway
    }
    await this.leaveRoom();
    // Delete the room so lingering agent sessions don't consume quota
    try {
      const roomSvc = new RoomServiceClient(
        this.config.livekitUrl,
        this.config.apiKey,
        this.config.apiSecret,
      );
      await roomSvc.deleteRoom(this.config.roomName);
    } catch {
      // Best-effort cleanup — don't fail the call if this errors
    }
  }

  // ── Post-call data ──────────────────────────────────────────

  async getCallData(): Promise<ObservedToolCall[]> {
    return this.toolCalls;
  }

  async getCallMetadata(): Promise<CallMetadata | null> {
    return {
      ...this.callMetadata,
      platform: "livekit",
      provider_session_id: this.callMetadata.provider_session_id ?? this.config.roomName,
      provider_debug_urls: compactStringRecord({
        ...this.callMetadata.provider_debug_urls,
        agent_insights: this.agentInsightsUrl(),
      }),
      ended_reason: this.callMetadata.ended_reason ?? this.disconnectReasonStr ?? undefined,
    };
  }

  /** LiveKit Cloud only. `p_` stands for the signed-in user's project; the dashboard resolves it. */
  private agentInsightsUrl(): string | undefined {
    if (!this.roomSid) return undefined;
    const host = new URL(this.config.livekitUrl).hostname;
    if (!host.endsWith(".livekit.cloud")) return undefined;
    return `https://cloud.livekit.io/projects/p_/sessions/${this.roomSid}/observability`;
  }

  /** STT/LLM/TTS latency per agent reply, from the metrics Vent's LiveKit helper forwards. */
  getComponentTimings(): ComponentLatency[] {
    return this.livekitMetricTimings.map((entry) => entry.timing);
  }

  getTranscripts(): PlatformUtterance[] {
    const utterances: PlatformUtterance[] = [];
    if (this.greetingTranscript) utterances.push({ role: "agent", text: this.greetingTranscript });
    for (const t of this.turnTimings) {
      if (t.userTranscript) utterances.push({ role: "caller", text: t.userTranscript });
      if (t.agentTranscript) utterances.push({ role: "agent", text: t.agentTranscript });
    }
    return utterances;
  }

  /** Receive-path diagnostics. Used by executor to log context when a
   *  collection times out with no speech — lets us tell whether the LiveKit
   *  agent never published a track, went quiet, or never finished a reply. */
  getReceiveDiagnostics(): string {
    const now = Date.now();
    const lastAssistantAge = this.rxLastAssistantItemAt !== null ? now - this.rxLastAssistantItemAt : null;
    const lastAgentStateAge = this.rxLastAgentStateAt !== null ? now - this.rxLastAgentStateAt : null;
    return (
      `[livekit-diag] tracks=${this.rxTracks} ` +
      `agentState="${this.lastAgentState ?? "?"}" agentStateAge=${lastAgentStateAge ?? "n/a"}ms ` +
      `lastAssistantItemAge=${lastAssistantAge ?? "n/a"}ms ` +
      `agentIdentity="${this.agentIdentity ?? "?"}" connected=${this.connected}`
    );
  }

  // ── Private helpers ─────────────────────────────────────────

  private handleObservabilityData(payload: Uint8Array, topic: string): void {
    try {
      const event = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
      this.handleObservabilityEvent(event, topic);
    } catch {
      // Ignore malformed data
    }
  }

  private handleObservabilityEvent(event: Record<string, unknown>, topic: string): void {
    switch (topic) {
      case VENT_EVENTS.toolCalls: {
        const toolCall = event as unknown as VentToolCallEvent;
        if (toolCall.type === "tool_call" && toolCall.name) {
          this.recordObservedToolCall(observedToolCall(toolCall, Date.now() - this.connectTimestamp));
        }
        break;
      }
      case VENT_EVENTS.metrics:
        this.handleMetricsEvent(event as unknown as LiveKitMetricsEvent);
        break;
      case VENT_EVENTS.conversationItem:
        this.handleConversationItemEvent(event as unknown as LiveKitConversationItemEvent);
        break;
      default: {
        // vent:call-metadata, vent:transfer, vent:debug-url, vent:warning
        const metadata = ventEventMetadata(topic, event, "livekit");
        if (metadata) this.addCallMetadata(metadata);
      }
    }
  }

  private addCallMetadata(metadata: Partial<CallMetadata>): void {
    this.callMetadata = mergeCallMetadata(this.callMetadata, metadata);
  }

  private handleMetricsEvent(event: LiveKitMetricsEvent): void {
    const extracted = event.metrics ? extractLiveKitMetricTiming(event.metrics) : undefined;
    if (extracted) {
      this.upsertMetricTiming(extracted);
    }
  }

  private handleConversationItemEvent(event: LiveKitConversationItemEvent): void {
    const { item } = event;
    if (item["type"] === "agent_handoff") {
      // JS stamps createdAt in ms, Python created_at in seconds, both since the epoch.
      const createdAtMs = typeof item["createdAt"] === "number"
        ? item["createdAt"]
        : typeof item["created_at"] === "number" ? item["created_at"] * 1000 : undefined;
      this.addCallMetadata({
        transfers: [{
          type: "agent_handoff",
          destination: (item["newAgentId"] ?? item["new_agent_id"]) as string,
          status: "completed",
          sources: ["platform_event"],
          timestamp_ms: createdAtMs != null ? Math.max(0, Math.round(createdAtMs - this.connectTimestamp)) : undefined,
        }],
      });
    }
    // conversation_item_added(role=="assistant") is the canonical "this
    // assistant turn is complete" signal — the message has been committed to
    // conversation history. More reliable than agent.state→listening, which
    // can flicker on barge-in or chained say() calls.
    if (item["role"] === "assistant") {
      this.rxLastAssistantItemAt = Date.now();
      this.emit("platformEndOfTurn");
    }
  }

  private upsertMetricTiming(extracted: LiveKitMetricTiming): void {
    if (!hasComponentLatencyContent(extracted.timing)) return;

    if (extracted.speechId) {
      const existingIndex = this.livekitMetricTimingIndexBySpeechId.get(extracted.speechId);
      if (existingIndex != null) {
        const existing = this.livekitMetricTimings[existingIndex];
        if (existing) {
          existing.timing = {
            stt_ms: extracted.timing.stt_ms ?? existing.timing.stt_ms,
            llm_ms: extracted.timing.llm_ms ?? existing.timing.llm_ms,
            tts_ms: extracted.timing.tts_ms ?? existing.timing.tts_ms,
            speech_duration_ms: extracted.timing.speech_duration_ms ?? existing.timing.speech_duration_ms,
          };
        }
        return;
      }

      this.livekitMetricTimingIndexBySpeechId.set(extracted.speechId, this.livekitMetricTimings.length);
    }

    this.livekitMetricTimings.push(extracted);
  }

  private recordObservedToolCall(toolCall: ObservedToolCall): void {
    const fingerprint = stableToolCallFingerprint(toolCall);
    if (this.toolCallFingerprints.has(fingerprint)) {
      return;
    }
    this.toolCallFingerprints.add(fingerprint);
    this.toolCalls.push(toolCall);
  }

  private isObservabilityParticipant(participant?: RemoteParticipant): boolean {
    if (!participant) return true;
    if (participant.kind === ParticipantKind.AGENT) {
      if (!this.agentIdentity) {
        this.agentIdentity = participant.identity;
      }
      return true;
    }
    return !!this.agentIdentity && participant.identity === this.agentIdentity;
  }

  private handleAgentStateChange(agentState: string, now = Date.now()): void {
    const turn = this.currentTurnIndex >= 0 ? this.turnTimings[this.currentTurnIndex] : undefined;
    const transition = applyLiveKitAgentStateChange(this.lastAgentState, turn, agentState, now);
    this.lastAgentState = transition.nextLastAgentState;
    this.rxLastAgentStateAt = now;
    if (transition.emitPlatformSpeechStart) {
      this.emit("platformSpeechStart");
    }
    if (transition.emitPlatformEndOfTurn) {
      this.emit("platformEndOfTurn");
    }
    if (transition.emitToolCallActive !== null) {
      this.emit("toolCallActive", transition.emitToolCallActive);
    }
  }

  private handleRoomDisconnected(reason: DisconnectReason): void {
    this.collecting = false;
    this.primaryAgentTrackSid = null;
    this.stopComfortNoise();
    this.disconnectReasonStr = DisconnectReason[reason] ?? "UNKNOWN";
    this.emit("disconnected");
  }

  private startReadingTrack(
    track: RemoteTrack,
    participantIdentity?: string,
    participantKind?: ParticipantKind,
  ): void {
    const who = `participant=${participantIdentity ?? "?"} kind=${participantKind ?? "?"}`;
    const sid = track.sid ?? null;
    if (sid && this.startedTrackSids.has(sid)) {
      console.log(`[livekit] startReadingTrack skipped (already started) ${who} sid=${sid}`);
      return;
    }
    if (sid) this.startedTrackSids.add(sid);
    console.log(`[livekit] startReadingTrack ${who}`);
    this.rxTracks++;
    void this.readAgentTrack(track, (samples) => this.isPrimaryTrackFrame(sid, samples, who))
      .then(() => console.log(`[livekit] Audio read loop ended ${who}`));
  }

  /**
   * Defense against multi-track agents (rare in stock LiveKit Agents but
   * possible with chained STT/TTS pipelines): lock onto the first track that
   * emits non-silent audio. Other tracks are still read (drained) but their
   * audio is dropped to avoid 50Hz interleave aliasing.
   */
  private isPrimaryTrackFrame(trackSid: string | null, samples: Int16Array, who: string): boolean {
    if (this.primaryAgentTrackSid === null) {
      let sumAbs = 0;
      for (let i = 0; i < samples.length; i++) sumAbs += Math.abs(samples[i]!);
      if (sumAbs / Math.max(1, samples.length) > WebRtcAudioChannel.PRIMARY_TRACK_MEAN_ABS_THRESHOLD) {
        this.primaryAgentTrackSid = trackSid;
        console.log(`[livekit] locked primary agent track ${who} sid=${trackSid}`);
      }
    }
    // Allow through if we haven't locked yet (single-track case) OR this is the locked track.
    return this.primaryAgentTrackSid === null || this.primaryAgentTrackSid === trackSid;
  }
}

/**
 * Timing from one LiveKit metrics payload, matched on its `type`. The JS Agents
 * SDK reports milliseconds (ttftMs, ttfbMs, transcriptionDelayMs, speechId); the
 * Python SDK reports seconds (ttft, ttfb, transcription_delay, speech_id). A
 * negative value means the SDK had none.
 */
function extractLiveKitMetricTiming(metrics: Record<string, unknown>): LiveKitMetricTiming | undefined {
  const ms = (jsMs: unknown, pythonSeconds: unknown): number | undefined => {
    if (typeof jsMs === "number") return jsMs >= 0 ? Math.round(jsMs) : undefined;
    if (typeof pythonSeconds === "number") return pythonSeconds >= 0 ? Math.round(pythonSeconds * 1000) : undefined;
    return undefined;
  };
  const speechId = (metrics["speechId"] ?? metrics["speech_id"]) as string | undefined;
  let timing: ComponentLatency;
  switch (metrics["type"]) {
    case "eou_metrics":
      timing = { stt_ms: ms(metrics["transcriptionDelayMs"], metrics["transcription_delay"]) };
      break;
    case "llm_metrics":
    case "realtime_model_metrics":
      timing = { llm_ms: ms(metrics["ttftMs"], metrics["ttft"]) };
      break;
    case "tts_metrics":
      timing = {
        tts_ms: ms(metrics["ttfbMs"], metrics["ttfb"]),
        speech_duration_ms: ms(metrics["audioDurationMs"], metrics["audio_duration"]),
      };
      break;
    default:
      return undefined;
  }
  return { speechId, timing };
}

function hasComponentLatencyContent(timing: Partial<ComponentLatency>): boolean {
  return timing.stt_ms != null || timing.llm_ms != null || timing.tts_ms != null || timing.speech_duration_ms != null;
}

function stableToolCallFingerprint(toolCall: ObservedToolCall): string {
  return JSON.stringify({
    name: toolCall.name,
    arguments: toolCall.arguments,
    provider_tool_type: toolCall.provider_tool_type,
    result: toolCall.result,
    successful: toolCall.successful,
    latency_ms: toolCall.latency_ms,
    timestamp_ms: toolCall.timestamp_ms,
  });
}
