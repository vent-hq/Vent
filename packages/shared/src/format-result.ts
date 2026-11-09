/**
 * Transforms raw ConversationCallResult into a structured, grouped format
 * for agent consumption (CLI).
 *
 * Groups metrics by concern and removes Vent internals by default. Verbose mode
 * re-attaches debug-only details such as harness timings, raw warnings, and
 * provider artifacts.
 */

import type {
  ConversationCallResult,
  ConversationTurn,
  ObservedToolCall,
  LatencyMetrics,
  ToolCallMetrics,
  CallMetadata,
  CallTransfer,
  CostBreakdown,
  UsageEntry,
  ComponentLatencyMetrics,
  ComponentLatency,
  HarnessOverhead,
  SignalQualityMetrics,
  ProviderWarning,
} from "./types.js";

// ---- Formatted types ----

interface FormattedTranscriptTurn {
  role: "caller" | "agent";
  text: string;
  ttfb_ms?: number;
  ttfw_ms?: number;
  audio_duration_ms?: number;
  debug?: {
    timestamp_ms: number;
    caller_decision_mode?: ConversationTurn["caller_decision_mode"];
    silence_pad_ms?: number;
    stt_confidence?: number;
    harness_tts_ms?: number;
    harness_stt_ms?: number;
    component_latency?: ComponentLatency;
    platform_transcript?: string;
  };
}

interface FormattedLatency {
  response_time_ms: number;
  response_time_source: "ttfw" | "ttfb";
  p95_response_time_ms: number;
  first_response_time_ms: number;
  // Verbose-only: extra percentiles, ttfw clones, drift, padding, m2e.
  p50_response_time_ms?: number;
  p90_response_time_ms?: number;
  p99_response_time_ms?: number;
  mean_ttfw_ms?: number;
  p50_ttfw_ms?: number;
  p90_ttfw_ms?: number;
  p95_ttfw_ms?: number;
  p99_ttfw_ms?: number;
  first_turn_ttfw_ms?: number;
  drift_slope_ms_per_turn?: number;
  mean_silence_pad_ms?: number;
  mouth_to_ear_est_ms?: number;
}

interface FormattedToolCalls {
  total: number;
  successful: number;
  failed: number;
  mean_latency_ms?: number;
  names: string[];
  observed: Array<{
    name: string;
    arguments: Record<string, unknown>;
    result?: unknown;
    successful?: boolean;
    provider_tool_type?: string;
    latency_ms?: number;
    turn_index?: number;
  }>;
}

interface FormattedComponentLatency {
  mean_stt_ms?: number;
  mean_llm_ms?: number;
  mean_tts_ms?: number;
  bottleneck?: "stt" | "llm" | "tts";
  // Verbose-only.
  p95_stt_ms?: number;
  p95_llm_ms?: number;
  p95_tts_ms?: number;
  mean_speech_duration_ms?: number;
}

interface FormattedCallMetadata {
  platform: string;
  provider_call_id?: string;
  provider_session_id?: string;
  ended_reason?: string;
  cost_usd?: number;
  recording_url?: string;
  transfer_attempted?: boolean;
  transfer_completed?: boolean;
  escalated?: boolean;
  transfer_count?: number;
  completed_transfer_count?: number;
  transfers?: CallTransfer[];
  // Verbose-only.
  cost_breakdown?: CostBreakdown;
  usage?: UsageEntry[];
  recording_variants?: Record<string, string>;
  provider_debug_urls?: Record<string, string>;
  variables?: Record<string, unknown>;
}

interface FormattedDebugToolCall {
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  successful?: boolean;
  provider_tool_type?: string;
  timestamp_ms?: number;
  latency_ms?: number;
  turn_index?: number;
}

interface FormattedConversationDebug {
  signal_quality?: SignalQualityMetrics;
  harness_overhead?: HarnessOverhead;
  provider_warnings?: ProviderWarning[];
  component_latency_per_turn?: ComponentLatency[];
  observed_tool_calls?: FormattedDebugToolCall[];
  provider_metadata?: Record<string, unknown>;
}

export interface FormattedConversationResult {
  name: string | null;
  status: "completed" | "error";
  duration_ms: number;
  error: string | null;
  end_note: string | null;
  transcript: FormattedTranscriptTurn[];
  latency: FormattedLatency | null;
  tool_calls: FormattedToolCalls;
  component_latency: FormattedComponentLatency | null;
  call_metadata: FormattedCallMetadata | null;
  // Optional in default mode: omitted when empty/null.
  warnings?: string[];
  caller_prompt?: string;
  debug?: FormattedConversationDebug;
}

export interface FormatConversationResultOptions {
  verbose?: boolean;
}

// ---- Public API ----

export function formatConversationResult(
  raw: unknown,
  options: FormatConversationResultOptions = {},
): FormattedConversationResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as ConversationCallResult;
  if (typeof r.caller_prompt !== "string") return null;

  const verbose = options.verbose ?? false;
  const debug = verbose ? formatDebug(r) : undefined;

  const warnings = dedupeStrings([
    ...formatProviderWarningMessages(r.call_metadata?.provider_warnings),
  ]);

  const result: FormattedConversationResult = {
    name: r.name ?? null,
    status: r.status,
    duration_ms: r.duration_ms,
    error: r.error ?? null,
    end_note: r.end_note ?? null,
    transcript: formatTranscript(r.transcript, options),
    latency: r.metrics?.latency ? formatLatency(r.metrics.latency, r.metrics, verbose) : null,
    tool_calls: formatToolCalls(r.metrics?.tool_calls, r.observed_tool_calls, verbose),
    component_latency: formatComponentLatency(r.metrics?.component_latency, verbose),
    call_metadata: formatCallMetadata(r.call_metadata, verbose),
  };

  if (warnings.length > 0) result.warnings = warnings;
  if (verbose) result.caller_prompt = r.caller_prompt;
  if (debug) result.debug = debug;

  return result;
}

// ---- Helpers ----


function formatTranscript(
  turns: ConversationTurn[] | undefined,
  options: FormatConversationResultOptions,
): FormattedTranscriptTurn[] {
  if (!turns) return [];
  return turns.map((t) => {
    const turn: FormattedTranscriptTurn = {
      role: t.role,
      text: t.text,
    };
    // Include user-facing timing fields when present.
    if (t.ttfb_ms != null) turn.ttfb_ms = t.ttfb_ms;
    if (t.ttfw_ms != null) turn.ttfw_ms = t.ttfw_ms;
    if (t.audio_duration_ms != null) turn.audio_duration_ms = t.audio_duration_ms;
    if (options.verbose) {
      const debug = compactUnknownRecord({
        timestamp_ms: t.timestamp_ms,
        caller_decision_mode: t.caller_decision_mode,
        silence_pad_ms: t.silence_pad_ms,
        stt_confidence: t.stt_confidence,
        harness_tts_ms: t.tts_ms,
        harness_stt_ms: t.stt_ms,
        component_latency: t.component_latency,
        platform_transcript: t.platform_transcript,
      });
      if (debug && Object.keys(debug).length > 0) {
        turn.debug = debug as FormattedTranscriptTurn["debug"];
      }
    }
    return turn;
  });
}

function formatLatency(latency: LatencyMetrics, metrics: ConversationCallResult["metrics"], verbose: boolean): FormattedLatency | null {
  const hasTtfw =
    metrics.mean_ttfw_ms != null
    && latency.p50_ttfw_ms != null
    && latency.p95_ttfw_ms != null;
  const responseTimeSource: "ttfw" | "ttfb" = hasTtfw ? "ttfw" : "ttfb";
  const firstResponse = hasTtfw ? (latency.first_turn_ttfw_ms ?? latency.first_turn_ttfb_ms) : latency.first_turn_ttfb_ms;
  if (firstResponse == null || (!hasTtfw && (metrics.mean_ttfb_ms == null || latency.p95_ttfb_ms == null))) return null;

  const result: FormattedLatency = {
    response_time_ms: hasTtfw ? metrics.mean_ttfw_ms! : metrics.mean_ttfb_ms!,
    response_time_source: responseTimeSource,
    p95_response_time_ms: hasTtfw ? latency.p95_ttfw_ms! : latency.p95_ttfb_ms!,
    first_response_time_ms: firstResponse,
  };

  if (!verbose) return result;

  // Verbose-only: extra percentiles, ttfw clones, drift, padding, m2e.
  result.p50_response_time_ms = hasTtfw ? latency.p50_ttfw_ms! : latency.p50_ttfb_ms;
  result.p90_response_time_ms = hasTtfw ? (latency.p90_ttfw_ms ?? latency.p90_ttfb_ms) : latency.p90_ttfb_ms;
  result.p99_response_time_ms = hasTtfw ? (latency.p99_ttfw_ms ?? latency.p99_ttfb_ms) : latency.p99_ttfb_ms;

  if (hasTtfw) {
    result.mean_ttfw_ms = metrics.mean_ttfw_ms;
    result.p50_ttfw_ms = latency.p50_ttfw_ms;
    result.p90_ttfw_ms = latency.p90_ttfw_ms ?? latency.p90_ttfb_ms;
    result.p95_ttfw_ms = latency.p95_ttfw_ms;
    result.p99_ttfw_ms = latency.p99_ttfw_ms ?? latency.p99_ttfb_ms;
    result.first_turn_ttfw_ms = latency.first_turn_ttfw_ms ?? latency.first_turn_ttfb_ms;
  }

  if (latency.drift_slope_ms_per_turn != null) result.drift_slope_ms_per_turn = latency.drift_slope_ms_per_turn;
  if (latency.mean_silence_pad_ms != null) result.mean_silence_pad_ms = latency.mean_silence_pad_ms;
  if (latency.mouth_to_ear_est_ms != null) result.mouth_to_ear_est_ms = latency.mouth_to_ear_est_ms;

  return result;
}

function formatToolCalls(
  summary: ToolCallMetrics | undefined,
  observed: ObservedToolCall[] | undefined,
  verbose: boolean,
): FormattedToolCalls {
  return {
    total: summary?.total ?? observed?.length ?? 0,
    successful: summary?.successful ?? observed?.filter((c) => c.successful).length ?? 0,
    failed: summary?.failed ?? observed?.filter((c) => c.successful === false).length ?? 0,
    mean_latency_ms: summary?.mean_latency_ms,
    names: summary?.names ?? [...new Set((observed ?? []).map((c) => c.name))],
    observed: (observed ?? []).map((c) => {
      const entry: FormattedToolCalls["observed"][number] = {
        name: c.name,
        arguments: stripExecutionMessage(c.arguments),
        result: verbose ? c.result : truncateLargeArrays(c.result),
        successful: c.successful,
        latency_ms: c.latency_ms,
        turn_index: c.turn_index,
      };
      // Only surface provider_tool_type when it carries information beyond the
      // generic "custom" default — that's the only value users care about
      // (e.g. "end_call", "transfer").
      if (c.provider_tool_type && c.provider_tool_type !== "custom") {
        entry.provider_tool_type = c.provider_tool_type;
      }
      return entry;
    }),
  };
}

const TOOL_RESULT_ARRAY_LIMIT = 5;

/**
 * Recursively walk a tool result and truncate any array longer than
 * TOOL_RESULT_ARRAY_LIMIT items, replacing the tail with a marker. Tool
 * results commonly include long lists of mock/test data the agent doesn't
 * need to read in full.
 */
function truncateLargeArrays(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length <= TOOL_RESULT_ARRAY_LIMIT) {
      return value.map(truncateLargeArrays);
    }
    return [
      ...value.slice(0, TOOL_RESULT_ARRAY_LIMIT).map(truncateLargeArrays),
      { _truncated: `${value.length - TOOL_RESULT_ARRAY_LIMIT} more entries omitted; use --verbose for full result` },
    ];
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = truncateLargeArrays(v);
    }
    return out;
  }
  return value;
}

/**
 * Drop the `execution_message` field from tool arguments. It's the agent's
 * pre-tool spoken prefix (e.g. "Looking up your account...") and is already
 * visible in the transcript — having it inline noises up the report.
 */
function stripExecutionMessage(args: Record<string, unknown>): Record<string, unknown> {
  if (!args || typeof args !== "object") return args;
  const { execution_message: _drop, ...rest } = args as Record<string, unknown>;
  void _drop;
  return rest;
}

function formatComponentLatency(cl: ComponentLatencyMetrics | undefined, verbose: boolean): FormattedComponentLatency | null {
  if (!cl) return null;
  const result: FormattedComponentLatency = {
    mean_stt_ms: cl.mean_stt_ms,
    mean_llm_ms: cl.mean_llm_ms,
    mean_tts_ms: cl.mean_tts_ms,
    bottleneck: cl.bottleneck,
  };
  if (!verbose) return result;
  const speechDurations = cl.per_turn
    .map((t) => t.speech_duration_ms)
    .filter((v): v is number => v != null);
  const meanSpeech = speechDurations.length > 0
    ? Math.round(speechDurations.reduce((a, b) => a + b, 0) / speechDurations.length)
    : undefined;
  result.p95_stt_ms = cl.p95_stt_ms;
  result.p95_llm_ms = cl.p95_llm_ms;
  result.p95_tts_ms = cl.p95_tts_ms;
  result.mean_speech_duration_ms = meanSpeech;
  return result;
}

function formatCallMetadata(meta: CallMetadata | undefined, verbose: boolean): FormattedCallMetadata | null {
  if (!meta) return null;
  const transfers = meta.transfers?.map((transfer) => {
    const formattedTransfer: CallTransfer = {
      type: transfer.type,
      destination: transfer.destination,
      status: transfer.status,
      sources: transfer.sources,
    };
    if (transfer.timestamp_ms != null) {
      formattedTransfer.timestamp_ms = transfer.timestamp_ms;
    }
    return formattedTransfer;
  });

  const result: FormattedCallMetadata = {
    platform: meta.platform,
    provider_call_id: meta.provider_call_id,
    provider_session_id: meta.provider_session_id,
    ended_reason: meta.ended_reason,
    cost_usd: meta.cost_usd,
    recording_url: meta.recording_url,
  };

  if (verbose) {
    result.cost_breakdown = meta.cost_breakdown;
    result.usage = meta.usage && meta.usage.length > 0 ? meta.usage : undefined;
    result.recording_variants = meta.recording_variants;
    result.provider_debug_urls = meta.provider_debug_urls;
    result.variables = meta.variables;
  }

  if (transfers && transfers.length > 0) {
    const completedTransferCount = transfers.filter((transfer) => transfer.status === "completed").length;
    const transferCompleted = completedTransferCount > 0;
    result.transfer_attempted = true;
    result.transfer_completed = transferCompleted;
    result.escalated = transferCompleted;
    result.transfer_count = transfers.length;
    result.completed_transfer_count = completedTransferCount;
    result.transfers = transfers;
  }

  return result;
}

function formatDebug(result: ConversationCallResult): FormattedConversationDebug | undefined {
  const debug = compactUnknownRecord({
    signal_quality: result.metrics?.signal_quality,
    harness_overhead: result.metrics?.harness_overhead,
    provider_warnings: nonEmptyArray(result.call_metadata?.provider_warnings),
    component_latency_per_turn: nonEmptyArray(result.metrics?.component_latency?.per_turn),
    observed_tool_calls: formatDebugToolCalls(result.observed_tool_calls),
    provider_metadata: result.call_metadata?.provider_metadata,
  });

  return debug && Object.keys(debug).length > 0
    ? debug as FormattedConversationDebug
    : undefined;
}

function formatDebugToolCalls(observed: ObservedToolCall[] | undefined): FormattedDebugToolCall[] | undefined {
  if (!observed || observed.length === 0) return undefined;
  return observed.map((call) => ({
    name: call.name,
    arguments: call.arguments,
    result: call.result,
    successful: call.successful,
    provider_tool_type: call.provider_tool_type,
    timestamp_ms: call.timestamp_ms,
    latency_ms: call.latency_ms,
    turn_index: call.turn_index,
  }));
}

function nonEmptyArray<T>(value: T[] | undefined): T[] | undefined {
  return value && value.length > 0 ? value : undefined;
}

function formatProviderWarningMessages(warnings: ProviderWarning[] | undefined): string[] {
  if (!warnings || warnings.length === 0) return [];
  return warnings
    .map((warning) => warning.message ?? warning.code)
    .filter((message): message is string => typeof message === "string" && message.length > 0);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function compactUnknownRecord(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value != null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

