/**
 * Transforms raw ConversationCallResult into a structured, grouped format
 * for agent consumption (CLI).
 *
 * Groups metrics by concern and leaves out Vent internals. The raw result
 * stays stored in full (runs.result_json); this is the one view of it.
 */

import type {
  ConversationCallResult,
  ConversationTurn,
  ObservedToolCall,
  CallMetadata,
  CallTransfer,
  CallCost,
  ProviderWarning,
} from "./types.js";
import { summarizeComponentLatency, summarizeLatency } from "./call-summaries.js";
import type {
  FormattedCallMetadata,
  FormattedConversationResult,
  FormattedToolCall,
  FormattedTranscriptTurn,
  RunOutput,
  UnformattedCall,
} from "./schemas/output.js";

// ---- Public API ----

export function formatConversationResult(raw: unknown): FormattedConversationResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as ConversationCallResult;
  if (typeof r.caller_prompt !== "string") return null;

  const warnings = dedupeStrings([
    ...formatProviderWarningMessages(r.call_metadata?.provider_warnings),
  ]);

  const result: FormattedConversationResult = {
    name: r.name ?? null,
    status: r.status,
    duration_ms: r.duration_ms,
    error: r.error ?? null,
    end_note: r.end_note ?? null,
    transcript: formatTranscript(r.transcript, r.observed_tool_calls),
    platform_transcript: r.platform_transcript && r.platform_transcript.length > 0 ? r.platform_transcript : null,
    latency: summarizeLatency(r.transcript ?? []),
    component_latency: summarizeComponentLatency(r.metrics?.component_latency?.per_turn) ?? null,
    signal_quality: r.metrics?.signal_quality
      ? { mean_snr_db: r.metrics.signal_quality.mean_snr_db, max_clipping_ratio: r.metrics.signal_quality.max_clipping_ratio }
      : null,
    call_metadata: formatCallMetadata(r.call_metadata),
  };

  const withoutTurn = (r.observed_tool_calls ?? []).filter((c) => c.turn_index == null);
  if (withoutTurn.length > 0) result.tool_calls = withoutTurn.map(formatToolCall);
  if (warnings.length > 0) result.warnings = warnings;

  return result;
}

/** A finished or unfinished run as stored: one row in `runs`. */
export interface StoredRun {
  id: string;
  status: string;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  duration_ms: number | null;
  error_text: string | null;
  /** The raw call result (ConversationCallResult), or null if the run ended without one. */
  result_json: unknown;
}

/**
 * The run result exactly as the coding agent receives it. Built in one place
 * from the stored raw result: the stream's run_complete event and
 * GET /runs/:id both return this, so they can't disagree.
 */
export function buildRunOutput(run: StoredRun): RunOutput {
  const raw = run.result_json as ConversationCallResult | null;
  const calls = raw ? [formatConversationResult(raw) ?? unformattedCall(raw)] : [];
  const output: RunOutput = {
    run_id: run.id,
    status: run.status,
    total: calls.length,
    calls,
  };
  if (run.error_text != null) output.error_text = run.error_text;
  return output;
}

/** Minimal call entry for a stored result the formatter can't read. */
function unformattedCall(raw: unknown): UnformattedCall {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    name: typeof r["name"] === "string" ? r["name"] : "call",
    status: typeof r["status"] === "string" ? r["status"] : "unknown",
    duration_ms: typeof r["duration_ms"] === "number" ? r["duration_ms"] : undefined,
    error: typeof r["error"] === "string" ? r["error"] : null,
  };
}

// ---- Helpers ----


function formatTranscript(turns: ConversationTurn[] | undefined, toolCalls: ObservedToolCall[] = []): FormattedTranscriptTurn[] {
  if (!turns) return [];
  return turns.map((t, index) => {
    const turn: FormattedTranscriptTurn = { role: t.role, text: t.text };
    if (t.ttfw_ms != null) turn.ttfw_ms = t.ttfw_ms;
    if (t.audio_duration_ms != null) turn.audio_duration_ms = t.audio_duration_ms;
    const turnToolCalls = toolCalls.filter((c) => c.turn_index === index).map(formatToolCall);
    if (turnToolCalls.length > 0) turn.tool_calls = turnToolCalls;
    return turn;
  });
}

function formatToolCall(c: ObservedToolCall): FormattedToolCall {
  const entry: FormattedToolCall = {
    name: c.name,
    arguments: stripExecutionMessage(c.arguments),
    result: c.result,
    successful: c.successful,
    latency_ms: c.latency_ms,
  };
  // Only surface provider_tool_type when it carries information beyond the
  // generic "custom" default — that's the only value users care about
  // (e.g. "end_call", "transfer").
  if (c.provider_tool_type && c.provider_tool_type !== "custom") {
    entry.provider_tool_type = c.provider_tool_type;
  }
  return entry;
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

function formatCallMetadata(meta: CallMetadata | undefined): FormattedCallMetadata | null {
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
    cost: meta.cost ? formatCost(meta.cost) : undefined,
    recording_url: meta.recording_url,
    provider_debug_urls: meta.provider_debug_urls && Object.keys(meta.provider_debug_urls).length > 0
      ? meta.provider_debug_urls
      : undefined,
  };

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

/** Drops zero-cost categories (e.g. Vapi's `chat: 0` on a voice call). */
function formatCost(cost: CallCost): CallCost {
  const nonZero = Object.entries(cost.breakdown ?? {}).filter(([, usd]) => usd !== 0);
  return { total_usd: cost.total_usd, ...(nonZero.length > 0 ? { breakdown: Object.fromEntries(nonZero) } : {}) };
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
