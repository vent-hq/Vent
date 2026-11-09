import type { CallerAccent } from "./constants.js";

export type RunStatus = "queued" | "running" | "pass" | "fail";

export interface AccessCredentials {
  access_token: string;
  refresh_token: string;
}

// ============================================================
// Conversation call types
// ============================================================

export type AdapterType = "websocket" | "livekit" | "vapi" | "retell" | "elevenlabs" | "bland";
export type TransferMode = "cold" | "warm" | "unknown";
export type CallTransferStatus = "attempted" | "completed" | "cancelled" | "failed" | "unknown";
export type CallTransferSource = "platform_event" | "platform_metadata" | "tool_call";

export interface CallerPersona {
  pace?: "slow" | "normal" | "fast";
  clarity?: "clear" | "vague" | "rambling";
  disfluencies?: boolean;
  cooperation?: "cooperative" | "reluctant" | "hostile";
  emotion?: "neutral" | "cheerful" | "confused" | "frustrated" | "skeptical" | "rushed";
  memory?: "reliable" | "unreliable";
  intent_clarity?: "clear" | "indirect" | "vague";
  confirmation_style?: "explicit" | "vague";
}

// ============================================================
// Caller audio effects — real-world audio condition simulation
// ============================================================

/** Resolved effects for a single call — all values are concrete. */
export interface CallerAudioEffects {
  noise?: { type: "babble" | "white" | "pink"; snr_db: number };
  speed?: number;
  speakerphone?: boolean;
  mic_distance?: "close" | "normal" | "far";
  clarity?: number;
  accent?: CallerAccent;
  packet_loss?: number;
  jitter_ms?: number;
}

export interface ConversationCallSpec {
  name?: string;
  caller_prompt: string;
  max_turns: number;
  persona?: CallerPersona;
  /** Global audio effects applied to all caller audio (speakerphone, speed, noise, accent, etc.) */
  caller_audio?: CallerAudioEffects;
  /** ISO 639-1 language code for multilingual calls (e.g., "es", "fr", "de"). Caller speaks this language, STT transcribes it, judge evaluates in it. */
  language?: string;
  /** Caller voice gender (English only). "male" → aura-2-apollo-en, "female" → aura-2-thalia-en (default). Ignored if caller_audio.accent is set or language is non-English. */
  voice?: "male" | "female";
}

// ============================================================
// Tool call types
// ============================================================

export interface ObservedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  successful?: boolean;
  provider_tool_type?: string;
  timestamp_ms?: number;
  latency_ms?: number;
  turn_index?: number;
}

export interface ToolCallMetrics {
  total: number;
  successful: number;
  failed: number;
  mean_latency_ms?: number;
  names: string[];
}

/** Shared fields across all platform configs */
interface BasePlatformConfig {
  /** Max concurrent calls (platform-dependent) */
  max_concurrency?: number;
}

export interface BlandPlatformConfig extends BasePlatformConfig {
  provider: "bland";
  /** Bland API key (falls back to BLAND_API_KEY env) */
  bland_api_key?: string;
  /** Bland pathway ID (falls back to BLAND_PATHWAY_ID env) */
  bland_pathway_id?: string;
  /** Bland persona ID — reusable agent preset (falls back to BLAND_PERSONA_ID env) */
  persona_id?: string;
  /** Task prompt — used instead of pathway_id for simple agents */
  task?: string;
  /** Tool definitions (inline objects) or tool IDs (TL-xxx strings) */
  tools?: unknown[];
  /** Voice name ("maya", "josh") or custom voice clone UUID */
  voice?: string;
  /** Model: "base" (full features), "turbo" (fastest, limited features) */
  model?: string;
  /** Opening sentence — overrides any greeting in the task/pathway */
  first_sentence?: string;
  /** If true, agent waits for callee to speak first (default: false) */
  wait_for_greeting?: boolean;
  /** Max call duration in minutes (default: 30) */
  max_duration?: number;
  /** Temperature 0-1 (default: 0.7) */
  temperature?: number;
  /** Language code e.g. "babel-en", "babel-es" */
  language?: string;
  /** How quickly agent stops speaking when interrupted, in ms (default: 500) */
  interruption_threshold?: number;
  /** When true, agent ignores user interruptions entirely */
  block_interruptions?: boolean;
  /** When true, enable Bland's noise filtering on caller audio */
  noise_cancellation?: boolean;
  /** Background audio: "office", "cafe", "restaurant", "none", or null (default phone static) */
  background_track?: string | null;
  /** Boost transcription accuracy for specific words. Supports "word:boost_factor" */
  keywords?: string[];
  /** Key-value pairs accessible as {{variable}} in agent prompts/pathways */
  request_data?: Record<string, unknown>;
  /** Pronunciation overrides */
  pronunciation_guide?: Array<{ word: string; pronunciation: string; case_sensitive?: boolean; spaced?: boolean }>;
  /** Start pathway from a specific node instead of the default */
  start_node_id?: string;
  /** Specific pathway version to test (default: production) */
  pathway_version?: number;
}

export interface LiveKitPlatformConfig extends BasePlatformConfig {
  provider: "livekit";
  /** LiveKit API key (falls back to LIVEKIT_API_KEY env) */
  livekit_api_key?: string;
  /** LiveKit API secret (falls back to LIVEKIT_API_SECRET env) */
  livekit_api_secret?: string;
  /** LiveKit server URL, e.g. wss://your-app.livekit.cloud (falls back to LIVEKIT_URL env) */
  livekit_url?: string;
  /** Explicit agent dispatch — agent_name from WorkerOptions. Omit for automatic dispatch. */
  livekit_agent_name?: string;
}

export interface VapiPlatformConfig extends BasePlatformConfig {
  provider: "vapi";
  /** Vapi API key (falls back to VAPI_API_KEY env) */
  vapi_api_key?: string;
  /** Vapi assistant ID (falls back to VAPI_ASSISTANT_ID or VAPI_AGENT_ID env) */
  vapi_assistant_id?: string;
}

export interface RetellPlatformConfig extends BasePlatformConfig {
  provider: "retell";
  /** Retell API key (falls back to RETELL_API_KEY env) */
  retell_api_key?: string;
  /** Retell agent ID (falls back to RETELL_AGENT_ID env) */
  retell_agent_id?: string;
}

export interface ElevenLabsPlatformConfig extends BasePlatformConfig {
  provider: "elevenlabs";
  /** ElevenLabs API key (falls back to ELEVENLABS_API_KEY env) */
  elevenlabs_api_key?: string;
  /** ElevenLabs agent ID (falls back to ELEVENLABS_AGENT_ID env) */
  elevenlabs_agent_id?: string;
}

export type PlatformConfig =
  | BlandPlatformConfig
  | LiveKitPlatformConfig
  | VapiPlatformConfig
  | RetellPlatformConfig
  | ElevenLabsPlatformConfig;

export type PlatformProvider = PlatformConfig["provider"];

export interface CallSpec {
  call: ConversationCallSpec;
}

export interface ChannelStats {
  bytesSent: number;
  bytesReceived: number;
  errorEvents: string[];
  connectLatencyMs: number;
}

export interface ConversationTurn {
  role: "caller" | "agent";
  text: string;
  timestamp_ms: number;
  /** Caller decision mode that produced this turn, or the silent wait mode that led into an agent turn. */
  caller_decision_mode?: "continue" | "wait" | "closing" | "end_now";
  audio_duration_ms?: number;
  ttfb_ms?: number;
  /** Time to first word — VAD-detected speech onset (ms from audio sent) */
  ttfw_ms?: number;
  /** Dead audio before speech starts: ttfw_ms - ttfb_ms */
  silence_pad_ms?: number;
  stt_confidence?: number;
  /** Harness TTS synthesis time for this turn's caller audio (ms) */
  tts_ms?: number;
  /** Harness STT transcription time for this turn's agent audio (ms) */
  stt_ms?: number;
  /** Platform component latency breakdown for this turn (STT/LLM/TTS) */
  component_latency?: ComponentLatency;
  /** Platform's own STT transcript for cross-referencing with Vent's STT */
  platform_transcript?: string;
}

// ============================================================
// Deep metric types
// ============================================================

export interface LatencyMetrics {
  ttfb_per_turn_ms: number[];
  p50_ttfb_ms?: number;
  p90_ttfb_ms?: number;
  p95_ttfb_ms?: number;
  p99_ttfb_ms?: number;
  first_turn_ttfb_ms?: number;
  /** Time to first word (VAD speech onset) per agent turn */
  ttfw_per_turn_ms?: number[];
  p50_ttfw_ms?: number;
  p90_ttfw_ms?: number;
  p95_ttfw_ms?: number;
  p99_ttfw_ms?: number;
  first_turn_ttfw_ms?: number;
  /** Mean dead audio before speech (TTFW - TTFB) across agent turns */
  mean_silence_pad_ms?: number;
  /** Estimated mouth-to-ear latency: mean TTFW + channel connect latency */
  mouth_to_ear_est_ms?: number;
  /** TTFB drift slope — positive = degradation over turns (ms/turn) */
  drift_slope_ms_per_turn?: number;
}

export interface HarnessOverhead {
  /** Per-turn TTS synthesis time (ms) — our ElevenLabs call duration */
  tts_per_turn_ms: number[];
  /** Per-turn STT transcription time (ms) — our Deepgram call duration */
  stt_per_turn_ms: number[];
  mean_tts_ms: number;
  mean_stt_ms: number;
}


export interface SignalQualityMetrics {
  /** Mean signal-to-noise ratio across turns (dB). >20 good, <10 bad */
  mean_snr_db: number;
  /** Max clipping ratio across turns (0-1). >0.01 = distortion */
  max_clipping_ratio: number;
  /** Mean energy consistency across turns (0-1). <0.5 = unstable volume */
  energy_consistency: number;
  /** Total sudden volume drops across all turns */
  sudden_drops: number;
  /** Total sudden volume spikes across all turns */
  sudden_spikes: number;
  /** All turns have clean start/end (no clicks) */
  clean_edges: boolean;
}


// ============================================================
// Platform component latency (from VAPI WebSocket text frames)
// ============================================================

/** Per-turn component latency breakdown from platform events */
export interface ComponentLatency {
  stt_ms?: number;
  llm_ms?: number;
  tts_ms?: number;
  speech_duration_ms?: number;
}

/** Aggregated component latency across all turns */
export interface ComponentLatencyMetrics {
  per_turn: ComponentLatency[];
  mean_stt_ms?: number;
  mean_llm_ms?: number;
  mean_tts_ms?: number;
  p95_stt_ms?: number;
  p95_llm_ms?: number;
  p95_tts_ms?: number;
  /** Which component contributes most to latency */
  bottleneck?: "stt" | "llm" | "tts";
}

// ============================================================
// Platform call metadata (from GET /call/{id})
// ============================================================

/** Per-model LLM usage (token counts for cost estimation). */
export interface UsageEntry {
  type: string;
  provider: string;
  model: string;
  input_tokens?: number;
  output_tokens?: number;
}

/** Per-component cost breakdown from platform API */
export interface CostBreakdown {
  stt_usd?: number;
  llm_usd?: number;
  tts_usd?: number;
  transport_usd?: number;
  /** Platform fee (e.g. VAPI's per-minute charge) */
  platform_usd?: number;
  total_usd?: number;
  llm_prompt_tokens?: number;
  llm_completion_tokens?: number;
}

export interface ProviderWarning {
  message?: string;
  code?: string;
  detail?: unknown;
}

/** Post-call metadata from the voice platform API */
export interface CallMetadata {
  platform: string;
  /** Provider-visible call/conversation identifier for dashboard/API lookup. */
  provider_call_id?: string;
  /** Secondary runtime/session identifier when distinct from the call ID. */
  provider_session_id?: string;
  ended_reason?: string;
  cost_usd?: number;
  /** Per-component cost breakdown (STT/LLM/TTS/transport) */
  cost_breakdown?: CostBreakdown;
  recording_url?: string;
  /** Provider-specific alternate recording artifacts keyed by variant name. */
  recording_variants?: Record<string, string>;
  /** Provider-specific debug and deep-link URLs keyed by purpose. */
  provider_debug_urls?: Record<string, string>;
  /** Final pathway/agent variables at end of call (Bland: pathway state, Vapi: extracted data) */
  variables?: Record<string, unknown>;
  /** Provider/runtime warnings retained in a normalized structure. */
  provider_warnings?: ProviderWarning[];
  /** Per-model usage data (token counts, characters, audio duration) from in-agent events. */
  usage?: UsageEntry[];
  /** Provider-native artifacts that are valuable to retain but not worth fully normalizing yet. */
  provider_metadata?: Record<string, unknown>;
  /** Call transfers that occurred during the call */
  transfers?: CallTransfer[];
}

export interface CallTransfer {
  type: string;
  destination?: string;
  status: CallTransferStatus;
  sources: CallTransferSource[];
  timestamp_ms?: number;
}

export interface ConversationMetrics {
  /** Absent when response bytes cannot be distinguished from a continuous audio stream. */
  mean_ttfb_ms?: number;
  /** Mean time to first word (VAD speech onset) across agent turns */
  mean_ttfw_ms?: number;
  latency?: LatencyMetrics;
  tool_calls?: ToolCallMetrics;
  /** Raw audio signal quality (SNR, clipping, energy, F0) — aggregated across turns */
  signal_quality?: SignalQualityMetrics;
  harness_overhead?: HarnessOverhead;
  /** Per-component latency breakdown (STT/LLM/TTS) from platform events */
  component_latency?: ComponentLatencyMetrics;
}

export interface ConversationCallResult {
  name?: string;
  caller_prompt: string;
  status: "completed" | "error";
  /** How a completed call ended, when Vent ended it or the connection closed. */
  end_note?: string;
  transcript: ConversationTurn[];

  observed_tool_calls?: ObservedToolCall[];
  duration_ms: number;
  metrics: ConversationMetrics;
  error?: string;
  /** Platform call metadata (cost, ended reason, recording, analysis) */
  call_metadata?: CallMetadata;
}

export interface RunAggregateV2 {
  conversation_calls: { total: number; passed: number; failed: number };
  total_duration_ms: number;
  total_cost_usd?: number;
}

export interface RunnerCallbackPayloadV2 {
  run_id: string;
  status: "pass" | "fail";
  conversation_result: ConversationCallResult;
  aggregate: RunAggregateV2;
  error_text?: string;
}
