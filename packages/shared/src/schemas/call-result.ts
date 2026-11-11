/**
 * What one call produced: the stored, raw result. Every measurement is stored
 * once, on the turn or tool call it belongs to; averages, percentiles and drift
 * are computed from these when the result is formatted (call-summaries.ts).
 *
 * Written by: the runner (in the worker), sent to the API in the worker's result callback.
 * Read by: the API (stored in runs.result_json), the formatter (format-result.ts).
 *
 * Shape (defined below leaf-first, since each schema must exist before it's used):
 *   ConversationCallResult
 *     transcript: ConversationTurn[]       one entry per caller/agent turn
 *     observed_tool_calls: ObservedToolCall[]
 *     metrics: ConversationMetrics         what the turns can't reproduce
 *       signal_quality: SignalQualityMetrics
 *     call_metadata: CallMetadata          what the platform reports after the call
 *       cost: CallCost, provider_warnings: ProviderWarning[], transfers: CallTransfer[]
 */

import { z } from "zod";

/** Per-turn component latency breakdown from platform events */
export const ComponentLatencySchema = z.object({
  stt_ms: z.number().optional(),
  llm_ms: z.number().optional(),
  tts_ms: z.number().optional(),
  speech_duration_ms: z.number().optional(),
});

export const ConversationTurnSchema = z.object({
  role: z.enum(["caller", "agent"]),
  text: z.string(),
  timestamp_ms: z.number(),
  /** Caller decision mode that produced this turn, or the silent wait mode that led into an agent turn. */
  caller_decision_mode: z.enum(["continue", "wait", "closing", "end_now"]).optional(),
  audio_duration_ms: z.number().optional(),
  /** Time to first byte: from the caller's audio being sent to the first agent audio arriving (ms). */
  ttfb_ms: z.number().optional(),
  /** Time to first word: from the caller's audio being sent to the agent starting to speak, by voice detection (ms). */
  ttfw_ms: z.number().optional(),
  /** Dead audio before speech starts: ttfw_ms - ttfb_ms */
  silence_pad_ms: z.number().optional(),
  stt_confidence: z.number().optional(),
  /** Harness TTS synthesis time for this turn's caller audio (ms) */
  tts_ms: z.number().optional(),
  /** Harness STT transcription time for this turn's agent audio (ms) */
  stt_ms: z.number().optional(),
});

/** One turn of the agent platform's own record of the call. */
export const PlatformTurnSchema = z.object({
  role: z.enum(["caller", "agent"]),
  /** Agent turns: the text the agent's LLM wrote. Caller turns: what the agent's STT heard the caller say. */
  text: z.string(),
});

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

export const SignalQualityMetricsSchema = z.object({
  /** Mean signal-to-noise ratio across turns (dB). >20 good, <10 bad */
  mean_snr_db: z.number(),
  /** Max clipping ratio across turns (0-1). >0.01 = distortion */
  max_clipping_ratio: z.number(),
  /** Mean energy consistency across turns (0-1). <0.5 = unstable volume */
  energy_consistency: z.number(),
  /** Total sudden volume drops across all turns */
  sudden_drops: z.number().int().min(0),
  /** Total sudden volume spikes across all turns */
  sudden_spikes: z.number().int().min(0),
  /** All turns have clean start/end (no clicks) */
  clean_edges: z.boolean(),
});

/** Call cost as the provider reports it. `breakdown` uses the provider's own
 *  categories (USD) and is present only when the provider splits the cost. */
export const CallCostSchema = z.object({
  total_usd: z.number(),
  breakdown: z.record(z.number()).optional(),
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

/** Post-call metadata from the voice platform API */
export const CallMetadataSchema = z.object({
  platform: z.string(),
  /** Provider-visible call/conversation identifier for dashboard/API lookup. */
  provider_call_id: z.string().optional(),
  /** Secondary runtime/session identifier when distinct from the call ID. */
  provider_session_id: z.string().optional(),
  ended_reason: z.string().optional(),
  cost: CallCostSchema.optional(),
  recording_url: z.string().optional(),
  /** Provider-specific alternate recording artifacts keyed by variant name. */
  recording_variants: z.record(z.string()).optional(),
  /** Provider-specific debug and deep-link URLs keyed by purpose. */
  provider_debug_urls: z.record(z.string()).optional(),
  /** Provider/runtime warnings retained in a normalized structure. */
  provider_warnings: z.array(ProviderWarningSchema).optional(),
  /** Call transfers that occurred during the call */
  transfers: z.array(CallTransferSchema).optional(),
});

/** Call-level measurements that can't be recomputed from the turns. Averages,
 *  percentiles and drift are computed from the turns when formatting
 *  (call-summaries.ts), so they aren't stored. */
export const ConversationMetricsSchema = z.object({
  /** How long Vent's connection to the platform took to open; feeds the mouth-to-ear estimate. */
  connect_latency_ms: z.number().optional(),
  /** Raw audio signal quality (SNR, clipping, energy), aggregated across agent turns. */
  signal_quality: SignalQualityMetricsSchema.optional(),
  /** Every component timing the platform reported (STT/LLM/TTS). It can report
   *  more than Vent has agent turns, so this is the full list. */
  /** The platform's STT/LLM/TTS latencies for the call; the result shows their means. */
  component_latency: z.object({ per_turn: z.array(ComponentLatencySchema) }).optional(),
});

export const ConversationCallResultSchema = z.object({
  name: z.string().optional(),
  caller_prompt: z.string(),
  status: z.enum(["completed", "error"]),
  /** How a completed call ended, when Vent ended it or the connection closed. */
  end_note: z.string().optional(),
  /** Vent's record of the call: what Vent's caller said, and what Vent heard the agent say. */
  transcript: z.array(ConversationTurnSchema),
  /** The agent platform's own record of the call, when the platform provides one. */
  platform_transcript: z.array(PlatformTurnSchema).optional(),
  observed_tool_calls: z.array(ObservedToolCallSchema).optional(),
  duration_ms: z.number(),
  metrics: ConversationMetricsSchema,
  error: z.string().optional(),
  /** Platform call metadata (cost, ended reason, recording, analysis) */
  call_metadata: CallMetadataSchema.optional(),
});
