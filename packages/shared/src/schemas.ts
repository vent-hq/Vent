import { z } from "zod";

// ============================================================
// V2 Schemas — Dynamic voice agent calls
// ============================================================

export const CallerPersonaSchema = z.object({
  pace: z.enum(["slow", "normal", "fast"]).optional(),
  clarity: z.enum(["clear", "vague", "rambling"]).optional(),
  disfluencies: z.boolean().optional(),
  cooperation: z.enum(["cooperative", "reluctant", "hostile"]).optional(),
  emotion: z.enum(["neutral", "cheerful", "confused", "frustrated", "skeptical", "rushed"]).optional(),
  memory: z.enum(["reliable", "unreliable"]).optional(),
  intent_clarity: z.enum(["clear", "indirect", "vague"]).optional(),
  confirmation_style: z.enum(["explicit", "vague"]).optional(),
}).optional();

export const CallerAudioEffectsSchema = z.object({
  noise: z.object({
    type: z.enum(["babble", "white", "pink"]),
    snr_db: z.number().min(0).max(40).default(10),
  }).optional(),
  speed: z.number().min(0.5).max(2.0).optional(),
  speakerphone: z.boolean().optional(),
  mic_distance: z.enum(["close", "normal", "far"]).optional(),
  clarity: z.number().min(0).max(1).optional(),
  accent: z.string().optional(),
  packet_loss: z.number().min(0).max(0.3).optional(),
  jitter_ms: z.number().min(0).max(100).optional(),
});

export const ConversationCallSpecSchema = z.object({
  name: z.string().optional(),
  caller_prompt: z.string().min(1),
  max_turns: z.number().int().min(1).max(50).default(6),

  silence_threshold_ms: z.number().int().min(200).max(10000).optional(),
  persona: CallerPersonaSchema,
  caller_audio: CallerAudioEffectsSchema.optional(),
  /** ISO 639-1 language code for multilingual calls (e.g., "es", "fr", "de"). Caller speaks this language, STT transcribes it, judge evaluates in it. */
  language: z.string().min(2).max(5).optional(),
  /** Caller voice gender (English only; default female). Ignored if caller_audio.accent is set or language is non-English. */
  voice: z.enum(["male", "female"]).optional(),
});

export const CallSpecSchema = z.object({
  call: ConversationCallSpecSchema,
});

export const AdapterTypeSchema = z.enum(["websocket", "livekit", "vapi", "retell", "elevenlabs", "bland"]);
export const PlatformProviderSchema = z.enum(["bland", "livekit", "vapi", "retell", "elevenlabs"]);

// ============================================================
// Tool call schemas
// ============================================================

export const ObservedToolCallSchema = z.object({
  name: z.string(),
  arguments: z.record(z.unknown()),
  result: z.unknown().optional(),
  successful: z.boolean().optional(),
  provider_tool_type: z.string().optional(),
  timestamp_ms: z.number().optional(),
  latency_ms: z.number().optional(),
  turn_index: z.number().int().min(0).optional(),
});

export const ToolCallMetricsSchema = z.object({
  total: z.number().int().min(0),
  successful: z.number().int().min(0),
  failed: z.number().int().min(0),
  mean_latency_ms: z.number().optional(),
  names: z.array(z.string()),
});

const BasePlatformSchema = z.object({
  max_concurrency: z.number().int().min(1).optional(),
});

const BlandPlatformSchema = BasePlatformSchema.extend({
  provider: z.literal("bland"),
  bland_api_key: z.string().optional(),
  bland_pathway_id: z.string().optional(),
  persona_id: z.string().optional(),
  task: z.string().optional(),
  tools: z.array(z.unknown()).optional(),
  voice: z.string().optional(),
  model: z.string().optional(),
  first_sentence: z.string().optional(),
  wait_for_greeting: z.boolean().optional(),
  max_duration: z.number().optional(),
  temperature: z.number().min(0).max(1).optional(),
  language: z.string().optional(),
  interruption_threshold: z.number().optional(),
  block_interruptions: z.boolean().optional(),
  noise_cancellation: z.boolean().optional(),
  background_track: z.string().nullable().optional(),
  keywords: z.array(z.string()).optional(),
  request_data: z.record(z.unknown()).optional(),
  pronunciation_guide: z.array(z.object({
    word: z.string(),
    pronunciation: z.string(),
    case_sensitive: z.boolean().optional(),
    spaced: z.boolean().optional(),
  })).optional(),
  start_node_id: z.string().optional(),
  pathway_version: z.number().optional(),
});

const LiveKitPlatformSchema = BasePlatformSchema.extend({
  provider: z.literal("livekit"),
  livekit_api_key: z.string().optional(),
  livekit_api_secret: z.string().optional(),
  livekit_url: z.string().optional(),
  livekit_agent_name: z.string().optional(),
}).strict();

const VapiPlatformSchema = BasePlatformSchema.extend({
  provider: z.literal("vapi"),
  vapi_api_key: z.string().optional(),
  vapi_assistant_id: z.string().optional(),
});

const RetellPlatformSchema = BasePlatformSchema.extend({
  provider: z.literal("retell"),
  retell_api_key: z.string().optional(),
  retell_agent_id: z.string().optional(),
});

const ElevenLabsPlatformSchema = BasePlatformSchema.extend({
  provider: z.literal("elevenlabs"),
  elevenlabs_api_key: z.string().optional(),
  elevenlabs_agent_id: z.string().optional(),
});

export const PlatformConfigSchema = z.discriminatedUnion("provider", [
  BlandPlatformSchema,
  LiveKitPlatformSchema,
  VapiPlatformSchema,
  RetellPlatformSchema,
  ElevenLabsPlatformSchema,
]);

export const ConversationTurnSchema = z.object({
  role: z.enum(["caller", "agent"]),
  text: z.string(),
  timestamp_ms: z.number(),
  caller_decision_mode: z.enum(["continue", "wait", "closing", "end_now"]).optional(),
  audio_duration_ms: z.number().optional(),
  ttfb_ms: z.number().optional(),
  ttfw_ms: z.number().optional(),
  silence_pad_ms: z.number().optional(),
  stt_confidence: z.number().optional(),
  tts_ms: z.number().optional(),
  stt_ms: z.number().optional(),
  component_latency: z.object({
    stt_ms: z.number().optional(),
    llm_ms: z.number().optional(),
    tts_ms: z.number().optional(),
    speech_duration_ms: z.number().optional(),
  }).optional(),
  platform_transcript: z.string().optional(),
});

// ============================================================
// Deep metric schemas
// ============================================================

export const LatencyMetricsSchema = z.object({
  ttfb_per_turn_ms: z.array(z.number()),
  p50_ttfb_ms: z.number(),
  p90_ttfb_ms: z.number(),
  p95_ttfb_ms: z.number(),
  p99_ttfb_ms: z.number(),
  first_turn_ttfb_ms: z.number(),
  ttfw_per_turn_ms: z.array(z.number()).optional(),
  p50_ttfw_ms: z.number().optional(),
  p90_ttfw_ms: z.number().optional(),
  p95_ttfw_ms: z.number().optional(),
  p99_ttfw_ms: z.number().optional(),
  first_turn_ttfw_ms: z.number().optional(),
  mean_silence_pad_ms: z.number().optional(),
  mouth_to_ear_est_ms: z.number().optional(),
  drift_slope_ms_per_turn: z.number().optional(),
});


export const HarnessOverheadSchema = z.object({
  tts_per_turn_ms: z.array(z.number()),
  stt_per_turn_ms: z.array(z.number()),
  mean_tts_ms: z.number(),
  mean_stt_ms: z.number(),
});

export const SignalQualityMetricsSchema = z.object({
  mean_snr_db: z.number(),
  max_clipping_ratio: z.number(),
  energy_consistency: z.number(),
  sudden_drops: z.number().int().min(0),
  sudden_spikes: z.number().int().min(0),
  clean_edges: z.boolean(),
});

export const ComponentLatencySchema = z.object({
  stt_ms: z.number().optional(),
  llm_ms: z.number().optional(),
  tts_ms: z.number().optional(),
  speech_duration_ms: z.number().optional(),
});

export const ComponentLatencyMetricsSchema = z.object({
  per_turn: z.array(ComponentLatencySchema),
  mean_stt_ms: z.number().optional(),
  mean_llm_ms: z.number().optional(),
  mean_tts_ms: z.number().optional(),
  p95_stt_ms: z.number().optional(),
  p95_llm_ms: z.number().optional(),
  p95_tts_ms: z.number().optional(),
  bottleneck: z.enum(["stt", "llm", "tts"]).optional(),
});

export const UsageEntrySchema = z.object({
  type: z.string(),
  provider: z.string(),
  model: z.string(),
  input_tokens: z.number().int().optional(),
  output_tokens: z.number().int().optional(),
});

export const CostBreakdownSchema = z.object({
  stt_usd: z.number().optional(),
  llm_usd: z.number().optional(),
  tts_usd: z.number().optional(),
  transport_usd: z.number().optional(),
  platform_usd: z.number().optional(),
  total_usd: z.number().optional(),
  llm_prompt_tokens: z.number().int().optional(),
  llm_completion_tokens: z.number().int().optional(),
});

export const ProviderWarningSchema = z.object({
  message: z.string().optional(),
  code: z.string().optional(),
  detail: z.unknown().optional(),
});

export const CallTransferSchema = z.object({
  type: z.string(),
  destination: z.string().optional(),
  status: z.enum(["attempted", "completed", "cancelled", "failed", "unknown"]),
  sources: z.array(z.enum(["platform_event", "platform_metadata", "tool_call"])).min(1),
  timestamp_ms: z.number().optional(),
});

export const CallMetadataSchema = z.object({
  platform: z.string(),
  provider_call_id: z.string().optional(),
  provider_session_id: z.string().optional(),
  ended_reason: z.string().optional(),
  cost_usd: z.number().nullable().optional(),
  cost_breakdown: CostBreakdownSchema.optional(),
  recording_url: z.string().optional(),
  recording_variants: z.record(z.string()).optional(),
  provider_debug_urls: z.record(z.string()).optional(),
  variables: z.record(z.unknown()).optional(),
  usage: z.array(UsageEntrySchema).optional(),
  provider_warnings: z.array(ProviderWarningSchema).optional(),
  provider_metadata: z.record(z.unknown()).optional(),
  transfers: z.array(CallTransferSchema).optional(),
});

export const ConversationMetricsSchema = z.object({
  mean_ttfb_ms: z.number(),
  mean_ttfw_ms: z.number().optional(),
  latency: LatencyMetricsSchema.optional(),
  tool_calls: ToolCallMetricsSchema.optional(),
  signal_quality: SignalQualityMetricsSchema.optional(),
  harness_overhead: HarnessOverheadSchema.optional(),
  component_latency: ComponentLatencyMetricsSchema.optional(),
});

export const ConversationCallResultSchema = z.object({
  name: z.string().optional(),
  caller_prompt: z.string(),
  status: z.enum(["completed", "error"]),
  transcript: z.array(ConversationTurnSchema),

  observed_tool_calls: z.array(ObservedToolCallSchema).optional(),
  duration_ms: z.number(),
  metrics: ConversationMetricsSchema,
  error: z.string().optional(),
  call_metadata: CallMetadataSchema.optional(),
});

export const RunAggregateV2Schema = z.object({
  conversation_calls: z.object({
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
  }).default({ total: 0, passed: 0, failed: 0 }),
  total_duration_ms: z.number(),
  total_cost_usd: z.number().optional(),
});

// Terminal status the worker reports back to the API. Subset of the DB
// runStatusEnum (`queued|running|pass|fail|cancelled`) — the runner-callback
// only ever flips a run to a successful terminal state. `cancelled` is set
// by the stop endpoint; `queued`/`running` by the lifecycle. If a new
// runner-set terminal state is ever added, update both the DB enum and
// this tuple.
export const RUNNER_TERMINAL_STATUSES = ["pass", "fail"] as const;
export type RunnerTerminalStatus = (typeof RUNNER_TERMINAL_STATUSES)[number];

export const RunnerCallbackV2Schema = z.object({
  run_id: z.string().uuid(),
  status: z.enum(RUNNER_TERMINAL_STATUSES),
  conversation_result: ConversationCallResultSchema,
  aggregate: RunAggregateV2Schema,
  error_text: z.string().optional(),
});

export const RunEventCallbackSchema = z.object({
  run_id: z.string().uuid(),
  event_type: z.string().min(1).max(64),
  message: z.string().max(2000),
  metadata_json: z.record(z.unknown()).optional(),
});

export const CallProgressCallbackSchema = z.object({
  run_id: z.string().uuid(),
  completed: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  call_type: z.literal("conversation"),
  call_name: z.string().min(1).max(256),
  status: z.enum(["pass", "fail", "completed", "error"]),
  duration_ms: z.number().nonnegative(),
  result: z.record(z.unknown()).optional(),
});
