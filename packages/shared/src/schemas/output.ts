/**
 * The JSON the coding agent receives from `vent-hq run` (stdout), from the
 * stream's run_complete event, and from GET /runs/:id. Built from the stored
 * call result by buildRunOutput / formatConversationResult (format-result.ts).
 *
 * Written by: the API (format-result.ts). Read by: the CLI and the coding agent.
 */

import type { CallCost, CallTransfer, PlatformTurn } from "../types.js";
import type { ComponentLatencySummary, LatencySummary } from "../call-summaries.js";

/** One run: one call, plus why the run failed when it did. */
export interface RunOutput {
  run_id: string;
  status: string;
  total: number;
  calls: Array<FormattedConversationResult | UnformattedCall>;
  /** Why the run failed or was cancelled, when it was. */
  error_text?: string;
}

/** A stored result the formatter can't read (e.g. from a much older runner). */
export interface UnformattedCall {
  name: string;
  status: string;
  duration_ms?: number;
  error: string | null;
}

export interface FormattedTranscriptTurn {
  role: "caller" | "agent";
  text: string;
  /** Agent turns: time from the caller finishing to the agent's first word (ms). */
  ttfw_ms?: number;
  audio_duration_ms?: number;
  /** The tools the agent ran for this turn. On the call's last turn when the agent never replied after them. */
  tool_calls?: FormattedToolCall[];
}

export interface FormattedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  successful?: boolean;
  provider_tool_type?: string;
  latency_ms?: number;
}

/** Reply times across the call's agent turns. */
export type FormattedLatency = LatencySummary;

/** Mean time of each stage of the agent's pipeline, when the platform reports it. */
export type FormattedComponentLatency = ComponentLatencySummary;

export interface FormattedCallMetadata {
  platform: string;
  provider_call_id?: string;
  provider_session_id?: string;
  ended_reason?: string;
  cost?: CallCost;
  recording_url?: string;
  provider_debug_urls?: Record<string, string>;
  transfer_attempted?: boolean;
  transfer_completed?: boolean;
  escalated?: boolean;
  transfer_count?: number;
  completed_transfer_count?: number;
  transfers?: CallTransfer[];
}

/** The two audio checks that catch real problems. */
export interface FormattedSignalQuality {
  mean_snr_db: number;
  max_clipping_ratio: number;
}

export interface FormattedConversationResult {
  name: string | null;
  status: "completed" | "error";
  duration_ms: number;
  error: string | null;
  end_note: string | null;
  /** Vent's record of the call: what Vent's caller said, and what Vent heard the agent say. */
  transcript: FormattedTranscriptTurn[];
  /** The agent platform's own record: what its LLM wrote (agent) and what its STT heard (caller). */
  platform_transcript: PlatformTurn[] | null;
  latency: FormattedLatency | null;
  /** Tool calls not on a turn: only when the call failed and its transcript was lost. The rest are on their turns. */
  tool_calls?: FormattedToolCall[];
  component_latency: FormattedComponentLatency | null;
  signal_quality: FormattedSignalQuality | null;
  call_metadata: FormattedCallMetadata | null;
  /** Provider warnings; omitted when there are none. */
  warnings?: string[];
}
