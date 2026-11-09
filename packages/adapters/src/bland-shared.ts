/**
 * Bland AI shared utilities.
 *
 * Types, constants, and post-call helpers used by the Bland WebSocket adapter.
 */

import type { ObservedToolCall, CallMetadata, CallTransfer, ComponentLatency } from "@vent/shared";

export const BLAND_API_BASE = "https://api.bland.ai";

// ── Types ────────────────────────────────────────────────────

/** Bland call parameters passable from platform config */
export interface BlandCallOptions {
  /** Task prompt — used instead of pathway_id for simple agents */
  task?: string;
  /** Tool definitions (inline objects) or tool IDs (TL-xxx strings) */
  tools?: unknown[];
  /** Voice name ("maya", "josh") or UUID */
  voice?: string;
  /** Model: "base" (full features), "enhanced" (faster), "turbo" (fastest, no tools) */
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
  /** When true, agent will not respond to or process interruptions from the user */
  block_interruptions?: boolean;
  /** When true, enable Bland's noise filtering on caller audio */
  noise_cancellation?: boolean;
  /** Background audio: "office", "cafe", "restaurant", "none", or null (default phone static) */
  background_track?: string | null;
  /** Boost transcription accuracy for specific words. Supports "word:boost_factor" format. */
  keywords?: string[];
  /** Key-value pairs accessible as {{variable}} in agent prompts/pathways */
  request_data?: Record<string, unknown>;
  /** Pronunciation overrides: [{ word, pronunciation, case_sensitive?, spaced? }] */
  pronunciation_guide?: Array<{ word: string; pronunciation: string; case_sensitive?: boolean; spaced?: boolean }>;
  /** Start pathway from a specific node instead of the default */
  start_node_id?: string;
  /** Specific pathway version to call (default: production) */
  pathway_version?: number;
  /** Bland persona ID — reusable agent preset */
  persona_id?: string;
}

export interface BlandCallResponse {
  call_id: string;
  status: string;
  completed?: boolean;
  transcripts?: BlandTranscriptEntry[];
  concatenated_transcript?: string;
  variables?: Record<string, unknown>;
  pathway_logs?: BlandPathwayLogEntry[];
  call_length?: number;
  corrected_duration?: string;
  price?: number;
  recording_url?: string;
  summary?: string;
  answered_by?: string;
  call_ended_by?: string;
  error_message?: string;
  started_at?: string;
  end_at?: string;
  citations?: unknown;
  warm_transfer_call?: {
    state?: string;
    proxy_agent_calls?: Array<{
      state?: string;
      call_id?: string;
      phone_number?: string;
    }>;
  };
  is_proxy_agent_call?: boolean;
  transferred_to?: string;
  transferred_at?: string;
}

export interface BlandTranscriptEntry {
  id: string;
  created_at: string;
  text: string;
  user: "user" | "assistant" | "robot" | "agent-action";
}

export interface BlandCorrectedTranscriptEntry {
  speaker: number;
  speaker_label: "user" | "assistant";
  text: string;
  start: number;
  end: number;
  confidence: number;
}

export interface BlandPathwayLogEntry {
  tag?: { name?: string; color?: string };
  role?: string;
  text?: string;
  decision?: string;
  created_at?: string;
  pathway_info?: string;
  chosen_node_id?: string;
}

// ── Post-call data fetching ──────────────────────────────────

/**
 * Find a web agent's call_id after the call. Bland only sends the `callID`
 * WebSocket frame for pathway agents; every web call is recorded with
 * `to` = the web agent ID, and GET /v1/calls lists newest first (it has no
 * filter for `to`, so match it here).
 */
/** One lookup of the call a Vent-created web agent received (matched by `to`). */
export async function findBlandCallIdByAgent(apiKey: string, agentId: string): Promise<string | null> {
  const res = await fetch(`${BLAND_API_BASE}/v1/calls?limit=50`, {
    headers: { authorization: apiKey },
  });
  if (!res.ok) throw new Error(`Bland list calls failed (${res.status})`);
  const { calls } = await res.json() as { calls?: Array<{ call_id?: string; to?: string }> };
  return calls?.find((call) => call.to === agentId)?.call_id ?? null;
}

/** One fetch of a call's post-call data. */
export async function fetchBlandCallResponse(apiKey: string, callId: string): Promise<BlandCallResponse> {
  const res = await fetch(`${BLAND_API_BASE}/v1/calls/${callId}`, {
    headers: { authorization: apiKey },
  });
  if (!res.ok) throw new Error(`Bland get call failed (${res.status})`);
  return await res.json() as BlandCallResponse;
}

export function isBlandCallDone(data: BlandCallResponse): boolean {
  return !!data.completed || data.status === "completed" || data.status === "failed";
}

/** Fetch corrected (speaker-diarized) transcripts for a call. */
export async function fetchBlandCorrectedTranscripts(
  apiKey: string,
  callId: string,
): Promise<BlandCorrectedTranscriptEntry[] | null> {
  try {
    const res = await fetch(`${BLAND_API_BASE}/v1/calls/${callId}/correct`, {
      headers: { authorization: apiKey },
    });
    if (res.ok) {
      const data = (await res.json()) as BlandCorrectedTranscriptEntry[] | { aligned?: BlandCorrectedTranscriptEntry[] };
      if (Array.isArray(data) && data.length > 0) {
        return data;
      } else if (!Array.isArray(data) && data.aligned?.length) {
        return data.aligned;
      }
    }
  } catch {
    // Non-critical — fall back to raw transcripts
  }
  return null;
}

/**
 * Fetch per-turn LLM/TTS latency from the call's event stream. Bland returns
 * `{ event_stream_data: [{ category: "latency", message: "LLM: 184ms", ... }] }`.
 * It carries no STT timings.
 */
export async function fetchBlandEventStream(
  apiKey: string,
  callId: string,
): Promise<ComponentLatency[]> {
  try {
    const res = await fetch(`${BLAND_API_BASE}/v1/event_stream/${callId}`, {
      headers: { authorization: apiKey },
    });
    if (!res.ok) {
      console.warn(`[bland] Event stream: HTTP ${res.status} for ${callId}`);
      return [];
    }

    const raw = await res.json() as { event_stream_data?: Array<{ category?: string; message?: string }> };
    const events = raw.event_stream_data;
    if (!Array.isArray(events)) {
      console.warn(`[bland] Event stream: unexpected shape for ${callId}: ${JSON.stringify(raw).slice(0, 200)}`);
      return [];
    }

    const latencies: ComponentLatency[] = [];
    for (const evt of events) {
      if (evt.category !== "latency" || !evt.message) continue;
      const timing = parseLatencyMessage(evt.message);
      if (timing) latencies.push(timing);
    }
    console.log(`[bland] Event stream: ${latencies.length} latency entries of ${events.length} events for ${callId}`);
    return latencies;
  } catch (err) {
    console.warn(`[bland] Event stream fetch failed for ${callId}: ${(err as Error).message}`);
    return [];
  }
}

// ── Tool call / transfer parsing ─────────────────────────────

/**
 * Parse tool calls from Bland post-call API data (transcripts + pathway_logs).
 */
export function parseBlandToolCalls(data: BlandCallResponse): ObservedToolCall[] {
  const toolCalls: ObservedToolCall[] = [];
  const callStartMs = parseBlandTimestampMs(data.started_at);

  // 1. Parse agent-action transcript entries (inline tool calls)
  const transcripts = data.transcripts ?? [];
  for (const entry of transcripts) {
    if (entry.user === "agent-action") {
      try {
        const parsed = JSON.parse(entry.text) as {
          name?: string;
          tool?: string;
          type?: string;
          tool_type?: string;
          arguments?: Record<string, unknown>;
          result?: unknown;
        };
        toolCalls.push({
          name: parsed.name ?? parsed.tool ?? "unknown",
          arguments: parsed.arguments ?? {},
          result: parsed.result,
          provider_tool_type: parsed.tool_type ?? parsed.type,
          timestamp_ms: toRelativeBlandTimestampMs(entry.created_at, callStartMs),
        });
      } catch {
        toolCalls.push({
          name: entry.text,
          arguments: {},
          timestamp_ms: toRelativeBlandTimestampMs(entry.created_at, callStartMs),
        });
      }
    }
  }

  // 2. Parse pathway_logs for webhook node executions
  const pathwayLogs = data.pathway_logs ?? [];
  const seenWebhookNodes = new Set<string>();

  for (const log of pathwayLogs) {
    if (log.chosen_node_id && /webhook/i.test(log.chosen_node_id) && !seenWebhookNodes.has(log.chosen_node_id)) {
      seenWebhookNodes.add(log.chosen_node_id);
      const name = log.chosen_node_id.replace(/^webhook[_-]?/i, "") || log.chosen_node_id;

      let webhookResult: unknown = undefined;
      let webhookArgs: Record<string, unknown> = {};
      if (log.pathway_info) {
        try {
          const info = JSON.parse(log.pathway_info) as Record<string, unknown>;
          webhookResult = info.response ?? info.result ?? info;
          webhookArgs = (info.request_data ?? info.params ?? {}) as Record<string, unknown>;
        } catch { /* not JSON */ }
      }

      toolCalls.push({
        name,
        arguments: webhookArgs,
        result: webhookResult,
        successful: true,
        provider_tool_type: "webhook",
        timestamp_ms: toRelativeBlandTimestampMs(log.created_at, callStartMs),
      });
      continue;
    }

    if (log.pathway_info) {
      try {
        const info = JSON.parse(log.pathway_info) as Record<string, unknown>;
        if (typeof info.url === "string" || typeof info.webhook_url === "string") {
          const url = (info.url ?? info.webhook_url) as string;
          const name = log.chosen_node_id ?? log.tag?.name ?? url;
          toolCalls.push({
            name: name.replace(/\s+/g, "_").toLowerCase(),
            arguments: (info.request_data ?? info.params ?? info.body ?? {}) as Record<string, unknown>,
            result: info.response ?? info.result,
            successful: info.status_code === 200 || info.status === "success" || info.response != null,
            provider_tool_type: "webhook",
            timestamp_ms: toRelativeBlandTimestampMs(log.created_at, callStartMs),
          });
        }
      } catch { /* not JSON */ }
    }
  }

  return toolCalls;
}

/** Extract call transfers from Bland post-call data. */
export function extractBlandTransfers(data: BlandCallResponse): CallTransfer[] | undefined {
  if (data.is_proxy_agent_call) return undefined;

  const transfers: CallTransfer[] = [];

  // Warm transfers
  const warmTransfer = data.warm_transfer_call;
  if (warmTransfer) {
    const type = warmTransfer.state
      ? `warm_transfer_${warmTransfer.state.toLowerCase()}`
      : "warm_transfer";
    const status = resolveBlandTransferStatus(warmTransfer.state);
    const proxyCalls = warmTransfer.proxy_agent_calls ?? [];

    if (proxyCalls.length > 0) {
      for (const call of proxyCalls) {
        transfers.push({
          type: call.state ? `warm_transfer_${call.state.toLowerCase()}` : type,
          destination: call.phone_number,
          status: resolveBlandTransferStatus(call.state ?? warmTransfer.state),
          sources: ["platform_metadata"],
        });
      }
    } else {
      transfers.push({
        type,
        status,
        sources: ["platform_metadata"],
      });
    }
  }

  // Cold transfers
  if (data.transferred_to) {
    transfers.push({
      type: "cold_transfer",
      destination: data.transferred_to,
      status: "completed",
      timestamp_ms: toRelativeBlandTimestampMs(data.transferred_at, parseBlandTimestampMs(data.started_at)),
      sources: ["platform_metadata"],
    });
  }

  return transfers.length > 0 ? transfers : undefined;
}

/** Build ended_reason string from Bland call response. */
export function buildBlandEndedReason(data: BlandCallResponse): string | undefined {
  // Bland returns `status: null` for web calls; the schema accepts a string or nothing.
  let endedReason = data.status ?? undefined;
  if (data.call_ended_by) endedReason = `ended_by_${data.call_ended_by.toLowerCase()}`;
  if (data.error_message) endedReason = `error: ${data.error_message}`;
  return endedReason;
}

/** Build CallMetadata from Bland post-call data. */
export function buildBlandCallMetadata(
  data: BlandCallResponse,
  callId: string | null,
): CallMetadata {
  const durationS =
    data.corrected_duration != null
      ? parseFloat(data.corrected_duration)
      : data.call_length != null
        ? data.call_length * 60
        : undefined;

  // Bland's GET /v1/calls/{id} response doesn't include a cost field —
  // billing is dashboard-only. Estimate from duration × Bland's documented
  // connected-call rate ($0.09/min). This is a heuristic: actual charges
  // depend on the account plan and may include additional charges (voicemail,
  // unanswered attempt fees, etc.). Rounded to 4 decimals (≈ tenth of a cent).
  const BLAND_PRICE_PER_MIN_USD = 0.09;
  const cost_usd =
    durationS != null
      ? Math.round((durationS / 60) * BLAND_PRICE_PER_MIN_USD * 10_000) / 10_000
      : undefined;

  return {
    platform: "bland",
    provider_call_id: data.call_id ?? callId ?? undefined,
    ended_reason: buildBlandEndedReason(data),
    cost_usd,
    recording_url: data.recording_url ?? undefined,
    variables: data.variables,
    provider_warnings: data.error_message ? [{ message: data.error_message, code: "provider_error" }] : undefined,
    provider_metadata: compactUnknownRecord({
      duration_s: durationS,
      answered_by: data.answered_by,
      citations: data.citations,
    }),
    transfers: extractBlandTransfers(data),
  };
}

/** Build transcript array from Bland post-call data. */
export function buildBlandTranscripts(
  data: BlandCallResponse | null,
  correctedData: BlandCorrectedTranscriptEntry[] | null,
): Array<{ turnIndex: number; text: string }> {
  if (correctedData?.length) {
    const transcripts: Array<{ turnIndex: number; text: string }> = [];
    let callerTurnIndex = 0;
    for (const entry of correctedData) {
      if (entry.speaker_label === "user") {
        transcripts.push({ turnIndex: callerTurnIndex, text: stripBlandAnnotations(entry.text) });
        callerTurnIndex++;
      }
    }
    console.log(`[bland] Corrected transcripts: ${correctedData.length} entries -> ${transcripts.length} caller turns`);
    return transcripts;
  }

  if (!data?.transcripts) return [];

  const transcripts: Array<{ turnIndex: number; text: string }> = [];
  let callerTurnIndex = 0;
  for (const entry of data.transcripts) {
    if (entry.user === "user") {
      transcripts.push({ turnIndex: callerTurnIndex, text: stripBlandAnnotations(entry.text) });
      callerTurnIndex++;
    }
  }
  console.log(`[bland] Raw transcripts: ${data.transcripts.length} entries -> ${transcripts.length} caller turns`);
  return transcripts;
}

// ── Latency parsing ──────────────────────────────────────────

/** Parse a Bland latency message string into component timings. */
export function parseLatencyMessage(msg: string): ComponentLatency | null {
  const timing: ComponentLatency = {};
  const sttMatch = msg.match(/\bSTT[:\s]+(\d+)\s*ms/i);
  const llmMatch = msg.match(/\bLLM[:\s]+(\d+)\s*ms/i);
  const ttsMatch = msg.match(/\bTTS[:\s]+(\d+)\s*ms/i);

  if (sttMatch) timing.stt_ms = parseInt(sttMatch[1]!, 10);
  if (llmMatch) timing.llm_ms = parseInt(llmMatch[1]!, 10);
  if (ttsMatch) timing.tts_ms = parseInt(ttsMatch[1]!, 10);

  if (timing.stt_ms != null || timing.llm_ms != null || timing.tts_ms != null) {
    return timing;
  }
  return null;
}

// ── Helpers ──────────────────────────────────────────────────

function resolveBlandTransferStatus(state: string | undefined): CallTransfer["status"] {
  const normalized = state?.trim().toLowerCase();
  if (!normalized) return "unknown";
  if (normalized === "merged" || normalized === "completed" || normalized === "connected" || normalized === "success") {
    return "completed";
  }
  if (normalized === "cancelled" || normalized === "canceled") {
    return "cancelled";
  }
  if (normalized === "failed" || normalized === "error") {
    return "failed";
  }
  return "attempted";
}

export function compactUnknownRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value != null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function parseBlandTimestampMs(timestamp: string | undefined): number | undefined {
  if (!timestamp) return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function toRelativeBlandTimestampMs(timestamp: string | undefined, callStartMs: number | undefined): number | undefined {
  const absoluteMs = parseBlandTimestampMs(timestamp);
  if (absoluteMs == null || callStartMs == null) return undefined;
  return Math.max(0, absoluteMs - callStartMs);
}



/** Strip Bland-injected annotations like "<Block interruptions enabled. This message was ignored>" */
export function stripBlandAnnotations(text: string): string {
  return text.replace(/<[^>]*>/g, "").trim();
}
