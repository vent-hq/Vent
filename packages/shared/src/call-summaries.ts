/**
 * Call summaries — averages and the like computed from a call's stored turns
 * and tool calls when the result is formatted. A call result stores each
 * measurement once (on the turn or tool call it belongs to); nothing here is
 * stored.
 */

import type { ComponentLatency, ConversationTurn } from "./types.js";

export interface LatencySummary {
  /** Mean time from the caller finishing to the agent replying. */
  response_time_ms: number;
  p50_response_time_ms: number;
  /** The slowest reply. */
  max_response_time_ms: number;
  first_response_time_ms: number;
}

export interface ComponentLatencySummary {
  mean_stt_ms?: number;
  mean_llm_ms?: number;
  mean_tts_ms?: number;
}

/** Median of an already sorted list (the mean of the middle two for an even count). */
function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: number[]): number {
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/**
 * Reply times across agent turns: time to first spoken word when speech onset
 * was detected, else time to first audio byte. Null when no reply was timed.
 */
export function summarizeLatency(turns: ConversationTurn[]): LatencySummary | null {
  const agentTurns = turns.filter((t) => t.role === "agent");
  const ttfw = agentTurns.map((t) => t.ttfw_ms).filter((v): v is number => v != null);
  const values = ttfw.length > 0 ? ttfw : agentTurns.map((t) => t.ttfb_ms).filter((v): v is number => v != null);
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    response_time_ms: mean(values),
    p50_response_time_ms: median(sorted),
    max_response_time_ms: sorted[sorted.length - 1]!,
    first_response_time_ms: values[0]!,
  };
}

/** Mean of each platform-reported component (STT/LLM/TTS). The platform can
 *  report more timings than Vent has agent turns, so this reads the stored
 *  timing list, not the timings attached to turns. */
export function summarizeComponentLatency(perTurn: ComponentLatency[] | undefined): ComponentLatencySummary | undefined {
  if (!perTurn || perTurn.length === 0) return undefined;
  const meanOf = (field: "stt_ms" | "llm_ms" | "tts_ms") => {
    const values = perTurn.map((t) => t[field]).filter((v): v is number => v != null);
    return values.length > 0 ? mean(values) : undefined;
  };
  return { mean_stt_ms: meanOf("stt_ms"), mean_llm_ms: meanOf("llm_ms"), mean_tts_ms: meanOf("tts_ms") };
}

