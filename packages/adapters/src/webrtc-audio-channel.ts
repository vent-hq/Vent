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
  Room,
  RoomEvent,
  AudioSource,
  AudioStream,
  AudioFrame,
  LocalAudioTrack,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  ParticipantKind,
  DisconnectReason,
  IceTransportType,
  ContinualGatheringPolicy,
  type Participant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  dispose,
} from "@livekit/rtc-node";
import { RoomAgentDispatch, RoomConfiguration } from "@livekit/protocol";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { resample } from "@vent/voice";
import type { ObservedToolCall, CallMetadata, CallTransfer, ComponentLatency, ProviderWarning, UsageEntry } from "@vent/shared";
import { BaseAudioChannel, type SendAudioOptions } from "./audio-channel.js";

interface WsToolCallEvent {
  type: "tool_call";
  name: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  successful?: boolean;
  provider_tool_type?: string;
  tool_type?: string;
  duration_ms?: number;
}

interface LiveKitTransferEvent {
  type: "vent:transfer";
  transfer?: CallTransfer;
  destination?: string;
  status?: CallTransfer["status"];
  transfer_type?: string;
  timestamp_ms?: number;
  source?: CallTransfer["sources"][number];
}

interface LiveKitDebugUrlEvent {
  type: "vent:debug-url";
  label?: string;
  url?: string;
}

interface LiveKitMetricsEvent {
  type?: "vent:metrics";
  event?: string;
  metric_type?: string;
  metrics?: Record<string, unknown>;
  timestamp_ms?: number;
}

interface LiveKitConversationItemEvent {
  type?: "vent:conversation-item";
  event?: string;
  item?: Record<string, unknown>;
  conversation_item?: Record<string, unknown>;
  timestamp_ms?: number;
}

/** Per-turn timing from LiveKit agent state transitions + transcription streams */
interface LiveKitTurnTiming {
  audioSentAt?: number;
  /** Agent state → "thinking" (STT done, LLM processing) */
  thinkingAt?: number;
  /** First agent transcription chunk on lk.transcription (LLM first token) */
  firstAgentTextAt?: number;
  /** Agent state → "speaking" (TTS started) */
  speakingAt?: number;
  /** Agent state → "listening" (speech ended) */
  listeningAt?: number;
  /** User STT transcript from lk.transcription */
  userTranscript?: string;
}

interface LiveKitAgentStateTransition {
  nextLastAgentState: string;
  emitPlatformSpeechStart: boolean;
  emitPlatformEndOfTurn: boolean;
  /** Set to true when entering `thinking` mid-response (tool call / LLM work),
   *  false when leaving it. null means no change. */
  emitToolCallActive: boolean | null;
}

interface LiveKitRoomDisconnectState {
  disconnectTimestamp: number;
  disconnectReasonStr: string;
}

interface LiveKitMetricTiming {
  speechId?: string;
  timing: ComponentLatency;
}

const LIVEKIT_TOOL_CALL_TOPIC = "vent:tool-calls";
const LIVEKIT_SESSION_TOPIC = "vent:session";
const LIVEKIT_CALL_METADATA_TOPIC = "vent:call-metadata";
const LIVEKIT_TRANSFER_TOPIC = "vent:transfer";
const LIVEKIT_DEBUG_URL_TOPIC = "vent:debug-url";
const LIVEKIT_WARNING_TOPIC = "vent:warning";
const LIVEKIT_SESSION_REPORT_TOPIC = "vent:session-report";
const LIVEKIT_METRICS_TOPIC = "vent:metrics";
const LIVEKIT_CONVERSATION_ITEM_TOPIC = "vent:conversation-item";
const LIVEKIT_USER_INPUT_TRANSCRIBED_TOPIC = "vent:user-input-transcribed";
const LIVEKIT_SESSION_USAGE_TOPIC = "vent:session-usage";
const LIVEKIT_TRANSCRIPTION_TOPIC = "lk.transcription";
const LIVEKIT_AGENT_STATE_ATTR = "lk.agent.state";
const RAW_INTERRUPT_TRAILING_SILENCE_MS = 160;

export function applyLiveKitAgentStateChange(
  previousState: string | null,
  turn: LiveKitTurnTiming | undefined,
  agentState: string,
  now: number,
): LiveKitAgentStateTransition {
  switch (agentState) {
    case "thinking":
      if (turn && !turn.thinkingAt) {
        turn.thinkingAt = now;
      }
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
      if (turn && turn.speakingAt && !turn.listeningAt) {
        turn.listeningAt = now;
      }
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

export function resolveLiveKitRoomDisconnectState(
  reason: DisconnectReason,
  now: number,
  existingDisconnectTimestamp = 0,
): LiveKitRoomDisconnectState {
  return {
    disconnectTimestamp: existingDisconnectTimestamp || now,
    disconnectReasonStr: DisconnectReason[reason] ?? "UNKNOWN",
  };
}

export interface WebRtcAudioChannelConfig {
  livekitUrl: string;
  apiKey: string;
  apiSecret: string;
  roomName: string;
  /** Sample rate for LiveKit audio. Default: 48000 */
  livekitSampleRate?: number;
  /** Optional agent name for explicit dispatch (required if agent uses agent_name registration) */
  agentName?: string;
}

export class WebRtcAudioChannel extends BaseAudioChannel {
  /** LiveKit emits platformEndOfTurn via agent state transitions. */
  hasPlatformEndOfTurn = true;

  private config: WebRtcAudioChannelConfig;
  private room: Room | null = null;
  private audioSource: AudioSource | null = null;
  private localTrack: LocalAudioTrack | null = null;
  private livekitSampleRate: number;
  private collecting = false;
  private toolCalls: ObservedToolCall[] = [];
  private connectTimestamp = 0;

  // Component latency tracking from agent state transitions + transcriptions
  private turnTimings: LiveKitTurnTiming[] = [];
  private currentTurnIndex = -1;
  private disconnectTimestamp = 0;
  private agentIdentity: string | null = null;
  private disconnectReasonStr: string | null = null;
  private lastAgentState: string | null = null;
  private roomDisconnected = false;

  // Agent transcript accumulator for consumeAgentText(). Each LiveKit STT
  // segment fires an interim stream followed by a final stream, both sharing
  // a segment_id. We only append final streams and dedup by segment_id so a
  // retry (or a duplicate final) can't double-count.
  private agentTextBuffer = "";
  private finalizedAgentSegments = new Set<string>();
  // Cumulative receive-path stats, for diagnosing "agent went silent" failures.
  // Surfaced via getReceiveDiagnostics() and logged by the executor when a
  // collection times out with no speech detected.
  private rxTracks = 0;
  private rxFrames = 0;
  private rxSumAbs = 0;
  private rxSampleCount = 0;
  private rxPeakAbs = 0;
  private rxLastFrameAt: number | null = null;
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
  private rxLastAssistantItemAt: number | null = null;
  private rxLastAgentStateAt: number | null = null;
  private callMetadata: CallMetadata = { platform: "livekit" };
  private livekitMetricTimings: LiveKitMetricTiming[] = [];
  private livekitMetricTimingIndexBySpeechId = new Map<string, number>();
  private toolCallFingerprints = new Set<string>();

  // Segment-to-turn anchoring: lock each STT segment to the turn that was
  // active when the segment was first observed (interim or final).
  private segmentTurnMap = new Map<string, number>();
  private comfortNoiseActive = false;

  constructor(config: WebRtcAudioChannelConfig) {
    super();
    this.config = config;
    this.livekitSampleRate = config.livekitSampleRate ?? 48000;
    this.outputSampleRate = this.livekitSampleRate;
    this.enableRecordingCapture();
  }

  get connected(): boolean {
    return this.room !== null && !this.roomDisconnected;
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();
    const token = new AccessToken(
      this.config.apiKey,
      this.config.apiSecret,
      { identity: "vent-tester" }
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

    this.room = new Room();
    this.roomDisconnected = false;
    this.disconnectTimestamp = 0;
    this.disconnectReasonStr = null;
    this.agentIdentity = null;
    this.lastAgentState = null;
    this.agentTextBuffer = "";
    this.finalizedAgentSegments.clear();
    this.rxTracks = 0;
    this.rxFrames = 0;
    this.rxSumAbs = 0;
    this.rxSampleCount = 0;
    this.rxPeakAbs = 0;
    this.rxLastFrameAt = null;
    this.rxLastAssistantItemAt = null;
    this.rxLastAgentStateAt = null;
    this.callMetadata = { platform: "livekit" };

    // On Fly.io (and other containerized environments), direct UDP is unreliable
    // because containers sit behind WireGuard tunnels and HTTP proxies. Force
    // TURN relay so LiveKit uses TURN/TLS (TCP:443) which works through any proxy.
    const isFlyIo = !!process.env["FLY_MACHINE_ID"];
    const rtcConfig = isFlyIo
      ? {
          iceTransportType: IceTransportType.TRANSPORT_RELAY,
          continualGatheringPolicy: ContinualGatheringPolicy.GATHER_CONTINUALLY,
          iceServers: [],
        }
      : undefined;

    await this.room.connect(this.config.livekitUrl, jwt, {
      autoSubscribe: true,
      dynacast: true,
      rtcConfig,
    });
    this.collecting = true;
    this.connectTimestamp = Date.now();
    this._connectTimestampMs = this.connectTimestamp;
    this._connectMonotonicMs = performance.now();
    this.toolCalls = [];
    this.turnTimings = [];
    this.currentTurnIndex = -1;
    this.segmentTurnMap.clear();
    this.livekitMetricTimings = [];
    this.livekitMetricTimingIndexBySpeechId.clear();
    this.toolCallFingerprints.clear();
    this.startedTrackSids.clear();

    // ── Tool call capture via DataChannel ──────────────────────
    this.room.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
        if (!this.isObservabilityParticipant(participant)) return;
        if (topic === LIVEKIT_TOOL_CALL_TOPIC) {
          this.handleToolCallData(payload);
          return;
        }
        if (topic) {
          this.handleObservabilityData(payload, topic);
        }
      }
    );

    this.room.registerTextStreamHandler(LIVEKIT_TOOL_CALL_TOPIC, async (reader) => {
      const text = await reader.readAll();
      this.handleToolCallText(text);
    });

    for (const topic of LIVEKIT_OBSERVABILITY_TOPICS) {
      this.room.registerTextStreamHandler(topic, async (reader, participantInfo) => {
        if (this.agentIdentity && participantInfo.identity !== this.agentIdentity) return;
        const text = await reader.readAll();
        this.handleObservabilityText(text, topic);
      });
    }

    // ── Agent state transitions (lk.agent.state) ──────────────
    this.room.on(
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
    this.room.registerTextStreamHandler(
      LIVEKIT_TRANSCRIPTION_TOPIC,
      async (reader, participantInfo) => {
        const isUser = participantInfo.identity === "vent-tester";
        const turn = this.currentTurnIndex >= 0 ? this.turnTimings[this.currentTurnIndex] : undefined;

        if (isUser) {
          // Segment-anchored transcript assignment.
          // Each STT utterance has a unique lk.segment_id shared across
          // interim and final streams. The first stream (interim) arrives
          // while the correct turn is still active. The final stream may
          // arrive later during a different turn. We lock the segment to
          // the turn on first sight, then assign the final text there.
          const segmentId = reader.info?.attributes?.["lk.segment_id"];
          const isFinal = reader.info?.attributes?.["lk.transcription_final"] === "true";

          if (segmentId) {
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
            // Fallback: no segment_id — use current turn (old behavior)
            if (!isFinal) return;
            const text = await reader.readAll();
            if (turn && text) {
              turn.userTranscript = turn.userTranscript
                ? `${turn.userTranscript} ${text}`
                : text;
            }
          }
        } else {
          // Agent transcription. Per LiveKit docs, every STT segment produces
          // TWO streams sharing a segment_id: an interim stream (while the
          // segment is being processed) and a final stream (once complete).
          // "Replace interim messages with the final message when
          // lk.transcription_final is true." Accumulating both duplicates
          // every segment's text. We still read interim streams to capture
          // the first-token timestamp for TTFW latency, but only append
          // content from final streams — and dedup by segment_id in case a
          // retry produces the same final twice.
          const isFinal = reader.info?.attributes?.["lk.transcription_final"] === "true";
          const segmentId = reader.info?.attributes?.["lk.segment_id"];
          let firstChunkCaptured = false;
          const chunks: string[] = [];
          for await (const chunk of reader) {
            chunks.push(chunk);
            if (!firstChunkCaptured && turn) {
              if (!turn.firstAgentTextAt) {
                turn.firstAgentTextAt = Date.now();
              }
              firstChunkCaptured = true;
            }
          }
          if (!isFinal) return;
          if (segmentId && this.finalizedAgentSegments.has(segmentId)) return;
          if (segmentId) this.finalizedAgentSegments.add(segmentId);
          const text = chunks.join("");
          if (text) {
            this.agentTextBuffer += (this.agentTextBuffer ? " " : "") + text;
          }
        }
      }
    );

    // ── Disconnect reason capture ─────────────────────────────
    this.room.once(RoomEvent.Disconnected, (reason: DisconnectReason) => {
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
    this.room.on(
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
    this.audioSource = new AudioSource(this.livekitSampleRate, 1);
    this.localTrack = LocalAudioTrack.createAudioTrack(
      "vent-tester",
      this.audioSource
    );
    const publishOptions = new TrackPublishOptions();
    publishOptions.source = TrackSource.SOURCE_MICROPHONE;
    await this.room.localParticipant!.publishTrack(
      this.localTrack,
      publishOptions
    );

    // ── Comfort noise — keep Opus codec warm ────────────────
    // Without continuous audio frames, Opus enters DTX (silence) mode.
    // When real speech arrives minutes later, the codec ramps bitrate
    // linearly from 0 → 40kbps over 20s — the agent's VAD misses it.
    // Low-level white noise forces Opus to maintain a baseline bitrate.
    this.startComfortNoise();

    // Subscribe to existing remote audio tracks
    for (const participant of this.room.remoteParticipants.values()) {
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
    const AGENT_READY_TIMEOUT = 45_000;
    const agentReady = await new Promise<boolean>((resolve) => {
      const alreadyHasAudio = (p: RemoteParticipant) => {
        if (p.kind !== ParticipantKind.AGENT) return false;
        for (const pub of p.trackPublications.values()) {
          if (pub.track && pub.kind === TrackKind.KIND_AUDIO) return true;
        }
        return false;
      };

      const onTrackSubscribed = (
        _t: RemoteTrack,
        pub: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        if (participant.kind !== ParticipantKind.AGENT) return;
        if (pub.kind !== TrackKind.KIND_AUDIO) return;
        this.agentIdentity = participant.identity;
        clearTimeout(timer);
        this.room?.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
        resolve(true);
      };

      const timer = setTimeout(() => {
        this.room?.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
        resolve(false);
      }, AGENT_READY_TIMEOUT);

      // Fast-path: agent already published audio before we got here.
      for (const p of this.room!.remoteParticipants.values()) {
        if (alreadyHasAudio(p)) {
          this.agentIdentity = p.identity;
          clearTimeout(timer);
          resolve(true);
          return;
        }
      }

      this.room!.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    });

    if (!agentReady) {
      throw new Error(
        `LiveKit agent did not publish an audio track in room "${this.config.roomName}" within ${AGENT_READY_TIMEOUT / 1000}s. ` +
        `Ensure your agent is running and connected to ${this.config.livekitUrl}. ` +
        `If your agent uses agent_name in WorkerOptions, set "agent_name" in the platform config.`
      );
    }

    this._stats.connectLatencyMs = Date.now() - connectStart;
  }

  /**
   * Continuously send low-level white noise to keep Opus codec warm.
   * Without this, Opus enters DTX mode during greeting capture (~15-30s)
   * and when real speech arrives, bitrate ramps linearly from 0 → 40kbps
   * over 20s — the agent's VAD never detects speech.
   */
  startComfortNoise(): void {
    this.comfortNoiseActive = true;
    const sampleRate = this.livekitSampleRate;
    const chunkSamples = Math.floor(sampleRate * 0.02); // 20ms
    const AMPLITUDE = 400; // ~-30dBFS — enough to keep Opus out of DTX

    const sendLoop = async () => {
      while (this.comfortNoiseActive && this.audioSource) {
        const samples = new Int16Array(chunkSamples);
        for (let i = 0; i < chunkSamples; i++) {
          samples[i] = Math.floor((Math.random() * 2 - 1) * AMPLITUDE);
        }
        const frame = new AudioFrame(samples, sampleRate, 1, chunkSamples);
        try {
          await this.audioSource.captureFrame(frame);
        } catch {
          break; // AudioSource closed
        }
      }
    };
    sendLoop();
  }

  stopComfortNoise(): void {
    this.comfortNoiseActive = false;
    this.clearAudioBuffer();
  }

  protected override clearTransportQueue(): void {
    this.audioSource?.clearQueue();
  }

  /** Write a single 20ms audio frame to LiveKit's AudioSource. */
  protected async writeAudioFrame(samples: Int16Array, sampleRate: number): Promise<void> {
    if (!this.audioSource || !this.collecting) return;
    const copied = new Int16Array(samples);
    const frame = new AudioFrame(copied, sampleRate, 1, copied.length);
    await this.audioSource.captureFrame(frame);
  }

  override sendAudio(pcm: Buffer, opts?: SendAudioOptions): void {
    if (!this.audioSource || !this.collecting) return;
    if (this.comfortNoiseActive) this.stopComfortNoise();

    // Track turn timing
    this.currentTurnIndex++;
    this.turnTimings[this.currentTurnIndex] = { audioSentAt: Date.now() };
    this.lastAgentState = null;

    super.sendAudio(pcm, opts);
  }

  async disconnect(): Promise<void> {
    this.collecting = false;
    this.roomDisconnected = true;
    this.stopComfortNoise();
    this.disconnectTimestamp = Date.now();
    if (this.room) {
      this.room.unregisterTextStreamHandler(LIVEKIT_TOOL_CALL_TOPIC);
      try {
        this.room.unregisterTextStreamHandler(LIVEKIT_TRANSCRIPTION_TOPIC);
      } catch {
        // May not be registered if connect() failed partway
      }
      for (const topic of LIVEKIT_OBSERVABILITY_TOPICS) {
        try {
          this.room.unregisterTextStreamHandler(topic);
        } catch {
          // May not be registered if connect() failed partway
        }
      }
    }
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
    // NOTE: Do NOT call dispose() here — it destroys the global FFI runtime
    // and kills all other concurrent LiveKit sessions in this process.
    // Let process exit handle native cleanup.
  }

  // ── Post-call data ──────────────────────────────────────────

  async getCallData(): Promise<ObservedToolCall[]> {
    return this.toolCalls;
  }

  async getCallMetadata(): Promise<CallMetadata | null> {
    const durationS = this.disconnectTimestamp && this.connectTimestamp
      ? (this.disconnectTimestamp - this.connectTimestamp) / 1000
      : undefined;

    const providerMetadata = compactUnknownRecord({
      ...(this.callMetadata.provider_metadata ?? {}),
      room_name: this.config.roomName,
      agent_identity: this.agentIdentity,
      tool_call_instrumentation: this.toolCalls.length > 0 ? "custom_data_channel" : undefined,
    });

    return {
      ...this.callMetadata,
      platform: "livekit",
      provider_session_id: this.callMetadata.provider_session_id ?? this.config.roomName,
      ended_reason: this.callMetadata.ended_reason ?? this.disconnectReasonStr ?? undefined,
      provider_metadata: {
        ...providerMetadata,
        duration_s: (this.callMetadata.provider_metadata?.["duration_s"] as number | undefined) ?? durationS,
      },
    };
  }

  getComponentTimings(): ComponentLatency[] {
    const roomDerived = this.turnTimings.map((t) => {
      const stt_ms = t.audioSentAt != null && t.thinkingAt != null
        ? t.thinkingAt - t.audioSentAt : undefined;

      // If transcription stream provided first-token timing, split LLM and TTS
      const llm_ms = t.thinkingAt != null && t.firstAgentTextAt != null
        ? t.firstAgentTextAt - t.thinkingAt : undefined;
      const tts_ms = t.firstAgentTextAt != null && t.speakingAt != null
        ? Math.max(0, t.speakingAt - t.firstAgentTextAt) : undefined;

      const speech_duration_ms = t.speakingAt != null && t.listeningAt != null
        ? t.listeningAt - t.speakingAt : undefined;

      return { stt_ms, llm_ms, tts_ms, speech_duration_ms };
    });

    if (this.livekitMetricTimings.length === 0) {
      return roomDerived;
    }

    const metricDerived = this.livekitMetricTimings.map((entry) => entry.timing);
    const maxLength = Math.max(roomDerived.length, metricDerived.length);
    const merged: ComponentLatency[] = [];
    for (let i = 0; i < maxLength; i++) {
      const roomTiming = roomDerived[i];
      const metricTiming = metricDerived[i];
      merged.push({
        stt_ms: metricTiming?.stt_ms ?? roomTiming?.stt_ms,
        llm_ms: metricTiming?.llm_ms ?? roomTiming?.llm_ms,
        tts_ms: metricTiming?.tts_ms ?? roomTiming?.tts_ms,
        speech_duration_ms: metricTiming?.speech_duration_ms ?? roomTiming?.speech_duration_ms,
      });
    }
    return merged;
  }

  getTranscripts(): Array<{ turnIndex: number; text: string }> {
    const transcripts: Array<{ turnIndex: number; text: string }> = [];
    for (let i = 0; i < this.turnTimings.length; i++) {
      const t = this.turnTimings[i]!;
      if (t.userTranscript) {
        transcripts.push({ turnIndex: i, text: t.userTranscript });
      }
    }
    return transcripts;
  }

  /** Consume accumulated real-time agent transcript text (resets buffer). */
  consumeAgentText(): string {
    const text = this.agentTextBuffer;
    this.agentTextBuffer = "";
    return text;
  }

  /** Full caller transcript for WER computation (avoids turn alignment issues). */
  getFullCallerTranscript(): string {
    return this.turnTimings
      .filter(t => t.userTranscript)
      .map(t => t.userTranscript!)
      .join(" ");
  }

  /** Receive-path diagnostics. Used by executor to log rich context when a
   *  collection times out with no speech — lets us tell whether the LiveKit
   *  agent never published a track, published a track with zeroed samples
   *  (TTS failure), or produced audio that was too quiet for VAD. */
  getReceiveDiagnostics(): string {
    const now = Date.now();
    const meanAbs = this.rxSampleCount > 0 ? Math.round(this.rxSumAbs / this.rxSampleCount) : 0;
    const lastFrameAge = this.rxLastFrameAt !== null ? now - this.rxLastFrameAt : null;
    const lastAssistantAge = this.rxLastAssistantItemAt !== null ? now - this.rxLastAssistantItemAt : null;
    const lastAgentStateAge = this.rxLastAgentStateAt !== null ? now - this.rxLastAgentStateAt : null;
    return (
      `[livekit-diag] tracks=${this.rxTracks} frames=${this.rxFrames} ` +
      `meanAbs=${meanAbs} peakAbs=${this.rxPeakAbs} ` +
      `lastFrameAge=${lastFrameAge ?? "n/a"}ms ` +
      `agentState="${this.lastAgentState ?? "?"}" agentStateAge=${lastAgentStateAge ?? "n/a"}ms ` +
      `lastAssistantItemAge=${lastAssistantAge ?? "n/a"}ms ` +
      `agentIdentity="${this.agentIdentity ?? "?"}" roomDisconnected=${this.roomDisconnected}`
    );
  }

  // ── Private helpers ─────────────────────────────────────────

  private handleToolCallData(payload: Uint8Array): void {
    try {
      const text = new TextDecoder().decode(payload);
      this.handleToolCallText(text);
    } catch {
      // Ignore malformed data
    }
  }

  private handleToolCallText(text: string): void {
    try {
      const event = JSON.parse(text) as WsToolCallEvent;
      if (event.type === "tool_call" && event.name) {
        this.recordObservedToolCall({
          name: event.name,
          arguments: event.arguments ?? {},
          result: event.result,
          successful: event.successful,
          provider_tool_type: event.provider_tool_type ?? event.tool_type,
          timestamp_ms: Date.now() - this.connectTimestamp,
          latency_ms: event.duration_ms,
        });
      }
    } catch {
      // Ignore malformed JSON
    }
  }

  private handleObservabilityData(payload: Uint8Array, topic: string): void {
    try {
      const text = new TextDecoder().decode(payload);
      this.handleObservabilityText(text, topic);
    } catch {
      // Ignore malformed data
    }
  }

  private handleObservabilityText(text: string, topic: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (topic) {
      case LIVEKIT_SESSION_TOPIC:
      case LIVEKIT_CALL_METADATA_TOPIC:
        this.mergeCallMetadata(normalizeLiveKitMetadata(event));
        break;
      case LIVEKIT_TRANSFER_TOPIC:
        this.handleTransferEvent(event as unknown as LiveKitTransferEvent);
        break;
      case LIVEKIT_DEBUG_URL_TOPIC:
        this.handleDebugUrlEvent(event as unknown as LiveKitDebugUrlEvent);
        break;
      case LIVEKIT_WARNING_TOPIC:
        this.handleWarningEvent(event);
        break;
      case LIVEKIT_SESSION_REPORT_TOPIC:
        this.handleSessionReportEvent(event);
        break;
      case LIVEKIT_METRICS_TOPIC:
        this.handleMetricsEvent(event as unknown as LiveKitMetricsEvent);
        break;
      case LIVEKIT_CONVERSATION_ITEM_TOPIC:
        this.handleConversationItemEvent(event as unknown as LiveKitConversationItemEvent);
        break;
      case LIVEKIT_USER_INPUT_TRANSCRIBED_TOPIC:
        // Redundant — transcript comes from lk.transcription room signals
        break;
      case LIVEKIT_SESSION_USAGE_TOPIC:
        this.handleSessionUsageEvent(event);
        break;
    }
  }

  private mergeCallMetadata(metadata: Partial<CallMetadata>): void {
    if (!metadata.platform) {
      metadata.platform = this.callMetadata.platform;
    }

    this.callMetadata = {
      ...this.callMetadata,
      ...metadata,
      recording_variants: {
        ...(this.callMetadata.recording_variants ?? {}),
        ...(metadata.recording_variants ?? {}),
      },
      provider_debug_urls: {
        ...(this.callMetadata.provider_debug_urls ?? {}),
        ...(metadata.provider_debug_urls ?? {}),
      },
      provider_metadata: {
        ...(this.callMetadata.provider_metadata ?? {}),
        ...(metadata.provider_metadata ?? {}),
      },
      variables: {
        ...(this.callMetadata.variables ?? {}),
        ...(metadata.variables ?? {}),
      },
      provider_warnings: mergeProviderWarnings(this.callMetadata.provider_warnings, metadata.provider_warnings),
      transfers: mergeTransfers(this.callMetadata.transfers, metadata.transfers),
    };
  }

  private handleTransferEvent(event: LiveKitTransferEvent): void {
    const transfer = event.transfer ?? {
      type: event.transfer_type ?? "transfer",
      destination: event.destination,
      status: event.status ?? "unknown",
      sources: [event.source ?? "platform_event"],
      timestamp_ms: event.timestamp_ms,
    };
    this.mergeCallMetadata({ transfers: [transfer] });
  }

  private handleMetricsEvent(event: LiveKitMetricsEvent): void {
    const eventRecord = event as unknown as Record<string, unknown>;
    const metrics = firstRecord(event.metrics, eventRecord) ?? eventRecord;
    const metricType = inferLiveKitMetricType(metrics, event.metric_type, event.event);
    this.appendProviderMetadataListItem("livekit_metrics_events", compactUnknownRecord({
      metric_type: metricType,
      ...eventRecord,
    }) ?? eventRecord);

    const extracted = extractLiveKitMetricTiming(metrics, metricType);
    if (extracted) {
      this.upsertMetricTiming(extracted);
    }
  }

  private handleConversationItemEvent(event: LiveKitConversationItemEvent): void {
    this.appendProviderMetadataListItem("livekit_conversation_items", event);
    const derivedTransfer = extractTransferFromConversationItemEvent(event);
    if (derivedTransfer) {
      this.mergeCallMetadata({ transfers: [derivedTransfer] });
    }
    // conversation_item_added(role=="assistant") is the canonical "this
    // assistant turn is complete" signal — the message has been committed to
    // conversation history. More reliable than agent.state→listening, which
    // can flicker on barge-in or chained say() calls.
    const item = firstRecord(event.item, event.conversation_item);
    const role = item ? firstString(item["role"])?.toLowerCase() : undefined;
    if (role === "assistant") {
      this.rxLastAssistantItemAt = Date.now();
      this.emit("platformEndOfTurn");
    }
  }

  private handleSessionUsageEvent(event: Record<string, unknown>): void {
    const usage = firstRecord(event.usage, event.session_usage, event.data) ?? event;
    this.mergeCallMetadata({
      provider_metadata: compactUnknownRecord({
        livekit_session_usage: usage,
      }),
    });

    // Extract LLM usage entries only (token counts that matter for cost)
    const modelUsage = usage["model_usage"] as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(modelUsage) && modelUsage.length > 0) {
      const entries: UsageEntry[] = modelUsage
        .filter((m) => firstString(m["type"]) === "llm_usage")
        .map((m) => ({
          type: "llm_usage",
          provider: firstString(m["provider"]) ?? "",
          model: firstString(m["model"]) ?? "",
          input_tokens: firstNumber(m["input_tokens"]),
          output_tokens: firstNumber(m["output_tokens"]),
        }));

      if (entries.length > 0) {
        this.mergeCallMetadata({
          usage: entries,
        });
      }
    }
  }

  private handleDebugUrlEvent(event: LiveKitDebugUrlEvent): void {
    if (!event.label || !event.url) return;
    this.mergeCallMetadata({
      provider_debug_urls: {
        [event.label]: event.url,
      },
    });
  }

  private handleWarningEvent(event: Record<string, unknown>): void {
    const warning = compactProviderWarning({
      message: typeof event.message === "string" ? event.message : undefined,
      code: typeof event.code === "string" ? event.code : undefined,
      detail: event.detail,
    });
    if (!warning) return;

    this.mergeCallMetadata({
      provider_warnings: [warning],
    });
  }

  private handleSessionReportEvent(event: Record<string, unknown>): void {
    const report = firstRecord(event.report) ?? event;
    const providerSessionId = firstString(
      event.provider_session_id,
      event.session_id,
      report["provider_session_id"],
      report["session_id"],
      report["room_name"],
      report["roomName"],
    );

    this.mergeCallMetadata({
      provider_session_id: providerSessionId,
      provider_metadata: compactUnknownRecord({
        session_report: report,
      }),
    });

    for (const transfer of extractTransfersFromSessionReport(report)) {
      this.mergeCallMetadata({ transfers: [transfer] });
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

  private appendProviderMetadataListItem(key: string, value: unknown): void {
    const existing = Array.isArray(this.callMetadata.provider_metadata?.[key])
      ? [...(this.callMetadata.provider_metadata?.[key] as unknown[])]
      : [];
    existing.push(value);
    this.mergeCallMetadata({
      provider_metadata: {
        [key]: existing,
      },
    });
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
    this.roomDisconnected = true;
    this.primaryAgentTrackSid = null;
    this.stopComfortNoise();
    const state = resolveLiveKitRoomDisconnectState(reason, Date.now(), this.disconnectTimestamp);
    this.disconnectTimestamp = state.disconnectTimestamp;
    this.disconnectReasonStr = state.disconnectReasonStr;
    this.emit("disconnected");
  }

  private startReadingTrack(
    track: RemoteTrack,
    participantIdentity?: string,
    participantKind?: ParticipantKind,
  ): void {
    const who = `participant=${participantIdentity ?? "?"} kind=${participantKind ?? "?"}`;
    const sid = (track as { sid?: string }).sid ?? null;
    if (sid && this.startedTrackSids.has(sid)) {
      console.log(`[livekit] startReadingTrack skipped (already started) ${who} sid=${sid}`);
      return;
    }
    if (sid) this.startedTrackSids.add(sid);
    console.log(`[livekit] startReadingTrack ${who}`);
    this.rxTracks++;
    const stream = new AudioStream(track, this.livekitSampleRate, 1);
    const reader = stream.getReader();
    let frameCount = 0;
    let sumAbs = 0;
    let sampleCount = 0;
    let peakAbs = 0;
    let lastDiagFrame = 0;

    const readLoop = async () => {
      try {
        while (this.collecting) {
          const { value: frame, done } = await reader.read();
          if (done || !frame) break;

          frameCount++;

          // Sample-level diagnostics on raw pre-resample frame
          const rawSamples = new Int16Array(
            frame.data.buffer,
            frame.data.byteOffset,
            frame.data.byteLength / 2,
          );
          let frameSumAbs = 0;
          let framePeak = 0;
          for (let i = 0; i < rawSamples.length; i++) {
            const v = Math.abs(rawSamples[i]!);
            frameSumAbs += v;
            if (v > framePeak) framePeak = v;
          }
          sumAbs += frameSumAbs;
          sampleCount += rawSamples.length;
          if (framePeak > peakAbs) peakAbs = framePeak;
          // Accumulate into instance stats so getReceiveDiagnostics() can expose
          // them after the fact (used by executor when a collection timeout
          // fires with no speech, to distinguish "no audio track" from "all
          // zero samples" from "audio exists but below VAD threshold").
          this.rxFrames++;
          this.rxSumAbs += frameSumAbs;
          this.rxSampleCount += rawSamples.length;
          if (framePeak > this.rxPeakAbs) this.rxPeakAbs = framePeak;
          this.rxLastFrameAt = Date.now();

          if (frameCount === 1) {
            console.log(
              `[livekit] first_frame ${who} bytes=${frame.data.byteLength} samples=${rawSamples.length} sampleRate=${frame.sampleRate} peak=${framePeak} meanAbs=${Math.round(frameSumAbs / rawSamples.length)}`
            );
          }
          // Every 100 frames (~1s at 10ms), log cumulative stats to detect
          // whether signal is truly silent or just below VAD threshold.
          if (frameCount - lastDiagFrame >= 100) {
            lastDiagFrame = frameCount;
            console.log(
              `[livekit] frame=${frameCount} ${who} cumMeanAbs=${Math.round(sumAbs / Math.max(1, sampleCount))} cumPeak=${peakAbs}`
            );
          }

          const frameBuffer = Buffer.from(
            frame.data.buffer,
            frame.data.byteOffset,
            frame.data.byteLength
          );
          this._stats.bytesReceived += frameBuffer.length;
          // Resample from LiveKit rate → 24kHz for consumers
          const pcm24k = resample(frameBuffer, this.livekitSampleRate, 24000);

          // Defense against multi-track agents (rare in stock LiveKit Agents
          // but possible with chained STT/TTS pipelines): lock onto the first
          // track that emits non-silent audio. Other tracks are read (drained)
          // but their PCM is dropped to avoid 50Hz interleave aliasing.
          const frameMeanAbs = frameSumAbs / Math.max(1, rawSamples.length);
          const trackSid = (track as { sid?: string }).sid ?? null;
          if (
            this.primaryAgentTrackSid === null
            && frameMeanAbs > WebRtcAudioChannel.PRIMARY_TRACK_MEAN_ABS_THRESHOLD
          ) {
            this.primaryAgentTrackSid = trackSid;
            console.log(`[livekit] locked primary agent track ${who} sid=${trackSid}`);
          }
          // Allow through if we haven't locked yet (single-track case) OR
          // this is the locked track. Drop secondary track audio post-lock.
          if (this.primaryAgentTrackSid !== null && this.primaryAgentTrackSid !== trackSid) {
            continue;
          }

          this.captureAgentAudio(pcm24k, performance.now() - this._connectMonotonicMs);
          this.emit("audio", pcm24k);
        }
      } catch (err) {
        // Stream closed
        if (err instanceof Error) {
          this._stats.errorEvents.push(err.message);
        }
      }
      const finalMean = sampleCount > 0 ? Math.round(sumAbs / sampleCount) : 0;
      console.log(
        `[livekit] Audio read loop ended ${who} frames=${frameCount} meanAbs=${finalMean} peak=${peakAbs}`
      );
    };

    readLoop();
  }
}

function compactUnknownRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value != null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function compactStringRecord(record: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!record) return undefined;
  const compacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.length > 0) {
      compacted[key] = value;
    }
  }
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
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

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") {
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

function normalizeLiveKitMetadata(payload: Record<string, unknown>): Partial<CallMetadata> {
  const nested = firstRecord(payload["call_metadata"]);
  const source = nested ?? payload;
  const providerDebugUrls = firstRecord(source["provider_debug_urls"], source["debug_urls"]);
  const recordingVariants = firstRecord(source["recording_variants"]);
  const providerMetadata = firstRecord(source["provider_metadata"]);
  const variables = firstRecord(source["variables"]);
  const providerWarnings = normalizeProviderWarnings(source["provider_warnings"], source["warnings"]);

  return compactUnknownRecord({
    platform: firstString(source["platform"]) ?? "livekit",
    provider_call_id: firstString(source["provider_call_id"], source["call_id"]),
    provider_session_id: firstString(source["provider_session_id"], source["session_id"]),
    ended_reason: firstString(source["ended_reason"]),
    cost_usd: firstNumber(source["cost_usd"]),
    cost_breakdown: firstRecord(source["cost_breakdown"]),
    recording_url: firstString(source["recording_url"]),
    recording_variants: compactStringRecord(firstRecord(source["recording_variants"]) ?? recordingVariants),
    provider_debug_urls: compactStringRecord(firstRecord(source["provider_debug_urls"], source["debug_urls"]) ?? providerDebugUrls),
    variables,
    provider_warnings: providerWarnings,
    provider_metadata: {
      ...providerMetadata,
      duration_s: firstNumber(source["duration_s"]),
      summary: firstString(source["summary"]),
      success_evaluation: firstString(source["success_evaluation"]),
      user_sentiment: firstString(source["user_sentiment"]),
      call_successful: firstBoolean(source["call_successful"]),
      answered_by: firstString(source["answered_by"]),
    },
  }) as Partial<CallMetadata>;
}

function extractLiveKitMetricTiming(
  metrics: Record<string, unknown>,
  metricType?: string,
): LiveKitMetricTiming | undefined {
  const normalizedType = metricType?.toLowerCase();
  const speechId = firstString(
    metrics["speechId"],
    metrics["speech_id"],
  );

  if (normalizedType === "eou" || normalizedType === "end_of_utterance" || normalizedType === "eoumetrics") {
    const sttMs = firstNumber(metrics["endOfUtteranceDelayMs"], metrics["end_of_utterance_delay"], metrics["end_of_utterance_delay_ms"]);
    return sttMs != null ? { speechId, timing: { stt_ms: Math.round(sttMs) } } : undefined;
  }

  if (normalizedType === "llm" || normalizedType === "llmmetrics") {
    const llmMs = firstNumber(metrics["ttftMs"], metrics["ttft"], metrics["ttft_ms"]);
    return llmMs != null ? { speechId, timing: { llm_ms: Math.round(llmMs) } } : undefined;
  }

  if (normalizedType === "realtime" || normalizedType === "realtimemodel" || normalizedType === "realtimemodelmetrics") {
    const llmMs = firstNumber(metrics["ttftMs"], metrics["ttft"], metrics["ttft_ms"]);
    const speechDurationMs = firstNumber(metrics["sessionDurationMs"], metrics["session_duration"], metrics["session_duration_ms"]);
    return hasComponentLatencyContent({ llm_ms: llmMs, speech_duration_ms: speechDurationMs })
      ? {
          speechId,
          timing: {
            llm_ms: llmMs != null ? Math.round(llmMs) : undefined,
            speech_duration_ms: speechDurationMs != null ? Math.round(speechDurationMs) : undefined,
          },
        }
      : undefined;
  }

  if (normalizedType === "tts" || normalizedType === "ttsmetrics") {
    const ttsMs = firstNumber(metrics["ttfbMs"], metrics["ttfb"], metrics["ttfb_ms"]);
    const speechDurationMs = firstNumber(metrics["audioDurationMs"], metrics["audio_duration"], metrics["audio_duration_ms"]);
    return hasComponentLatencyContent({ tts_ms: ttsMs, speech_duration_ms: speechDurationMs })
      ? {
          speechId,
          timing: {
            tts_ms: ttsMs != null ? Math.max(0, Math.round(ttsMs)) : undefined,
            speech_duration_ms: speechDurationMs != null ? Math.round(speechDurationMs) : undefined,
          },
        }
      : undefined;
  }

  if (normalizedType === "stt" || normalizedType === "sttmetrics") {
    const sttMs = firstNumber(metrics["durationMs"], metrics["duration"], metrics["duration_ms"]);
    return sttMs != null ? { speechId, timing: { stt_ms: Math.round(sttMs) } } : undefined;
  }

  return undefined;
}

function inferLiveKitMetricType(metrics: Record<string, unknown>, ...typeHints: Array<string | undefined>): string | undefined {
  const hinted = typeHints.find((hint) => typeof hint === "string" && hint.length > 0);
  if (hinted) return hinted;
  if ("endOfUtteranceDelayMs" in metrics || "transcriptionDelayMs" in metrics || "end_of_utterance_delay" in metrics) return "eou";
  if ("sessionDurationMs" in metrics || "session_duration" in metrics || "inputTokens" in metrics || "outputTokens" in metrics) return "realtime";
  if ("charactersCount" in metrics || "ttfbMs" in metrics || "audioDurationMs" in metrics) return "tts";
  if ("completionTokens" in metrics || "promptTokens" in metrics || ("ttftMs" in metrics && "totalTokens" in metrics)) return "llm";
  if ("detectionDelay" in metrics || "numInterruptions" in metrics) return "interruption";
  if ("idleTimeMs" in metrics || "inferenceCount" in metrics) return "vad";
  if ("streamed" in metrics || "audioDurationMs" in metrics) return "stt";
  return undefined;
}

function extractTransferFromConversationItemEvent(event: LiveKitConversationItemEvent): CallTransfer | undefined {
  const item = firstRecord(event.item, event.conversation_item);
  if (!item) return undefined;

  const itemType = firstString(item["type"], item["kind"], item["item_type"])?.toLowerCase();
  if (itemType !== "agent_handoff" && itemType !== "handoff") {
    return undefined;
  }

  return {
    type: itemType,
    destination: firstString(
      item["new_agent_id"],
      item["newAgentId"],
      item["new_agent_type"],
      item["newAgentType"],
      item["to_agent"],
      item["toAgent"],
    ),
    status: "completed",
    sources: ["platform_event"],
    timestamp_ms: firstNumber(event.timestamp_ms, item["timestamp_ms"], item["timestampMs"]),
  };
}

function extractTransfersFromSessionReport(report: Record<string, unknown>): CallTransfer[] {
  const transfers: CallTransfer[] = [];
  for (const record of firstRecordArray(report["events"], report["history"])) {
    const derived = extractTransferFromConversationItemEvent({
      item: record,
      timestamp_ms: firstNumber(record["timestamp_ms"], record["timestampMs"]),
    });
    if (derived) {
      transfers.push(derived);
    }
  }
  return transfers;
}

function firstRecordArray(...values: unknown[]): Record<string, unknown>[] {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const records = value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
    if (records.length > 0) {
      return records;
    }
  }
  return [];
}

function hasComponentLatencyContent(timing: Partial<ComponentLatency>): boolean {
  return timing.stt_ms != null || timing.llm_ms != null || timing.tts_ms != null || timing.speech_duration_ms != null;
}

function compactProviderWarning(warning: ProviderWarning): ProviderWarning | undefined {
  const entries = Object.entries(warning).filter(([, value]) => value != null);
  return entries.length > 0 ? Object.fromEntries(entries) as ProviderWarning : undefined;
}

function normalizeProviderWarnings(...values: unknown[]): ProviderWarning[] | undefined {
  const warnings: ProviderWarning[] = [];
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      warnings.push({ message: value });
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && item.length > 0) {
        warnings.push({ message: item });
        continue;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      const warning = compactProviderWarning({
        message: firstString(record["message"], record["warning"], record["text"]),
        code: firstString(record["code"], record["type"]),
        detail: record["detail"] ?? record["data"],
      });
      if (warning) warnings.push(warning);
    }
  }
  return warnings.length > 0 ? warnings : undefined;
}

function mergeProviderWarnings(
  existing: ProviderWarning[] | undefined,
  incoming: ProviderWarning[] | undefined,
): ProviderWarning[] | undefined {
  if ((!existing || existing.length === 0) && (!incoming || incoming.length === 0)) return undefined;
  const merged = new Map<string, ProviderWarning>();
  for (const warning of [...(existing ?? []), ...(incoming ?? [])]) {
    const normalized = compactProviderWarning(warning);
    if (!normalized) continue;
    merged.set(stableProviderWarningFingerprint(normalized), normalized);
  }
  return merged.size > 0 ? [...merged.values()] : undefined;
}

function stableProviderWarningFingerprint(warning: ProviderWarning): string {
  return JSON.stringify({
    message: warning.message,
    code: warning.code,
    detail: warning.detail,
  });
}

function mergeTransfers(
  existing: CallTransfer[] | undefined,
  incoming: CallTransfer[] | undefined,
): CallTransfer[] | undefined {
  if ((!existing || existing.length === 0) && (!incoming || incoming.length === 0)) return undefined;
  const merged = new Map<string, CallTransfer>();
  for (const transfer of [...(existing ?? []), ...(incoming ?? [])]) {
    const key = stableTransferFingerprint(transfer);
    const prior = merged.get(key);
    if (!prior) {
      merged.set(key, {
        ...transfer,
        sources: [...new Set(transfer.sources)],
      });
      continue;
    }

    merged.set(key, {
      ...prior,
      sources: [...new Set([...prior.sources, ...transfer.sources])],
      timestamp_ms: prior.timestamp_ms ?? transfer.timestamp_ms,
    });
  }
  return merged.size > 0 ? [...merged.values()] : undefined;
}

function stableTransferFingerprint(transfer: CallTransfer): string {
  return JSON.stringify({
    type: transfer.type,
    destination: transfer.destination,
    status: transfer.status,
    timestamp_ms: transfer.timestamp_ms,
  });
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

const LIVEKIT_OBSERVABILITY_TOPICS = [
  LIVEKIT_SESSION_TOPIC,
  LIVEKIT_CALL_METADATA_TOPIC,
  LIVEKIT_TRANSFER_TOPIC,
  LIVEKIT_DEBUG_URL_TOPIC,
  LIVEKIT_WARNING_TOPIC,
  LIVEKIT_SESSION_REPORT_TOPIC,
  LIVEKIT_METRICS_TOPIC,
  LIVEKIT_CONVERSATION_ITEM_TOPIC,
  LIVEKIT_USER_INPUT_TRANSCRIBED_TOPIC,
  LIVEKIT_SESSION_USAGE_TOPIC,
] as const;
