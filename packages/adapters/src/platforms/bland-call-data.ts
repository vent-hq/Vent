/**
 * Bland AI post-call data: fetching a finished call's details, transcripts and
 * latency, and reading them into Vent's result shapes.
 */

import type { ObservedToolCall, CallMetadata, CallTransfer, ComponentLatency } from "@vent/shared";
import type { PlatformUtterance } from "../shared/audio-channel.js";

export const BLAND_API_BASE = "https://api.bland.ai";

// ── Types ────────────────────────────────────────────────────

export interface BlandCallResponse {
  call_id: string;
  status: string;
  completed?: boolean;
  transcripts?: BlandTranscriptEntry[];
  concatenated_transcript?: string;
  pathway_id?: string | null;
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

interface BlandTranscriptEntry {
  id: string;
  created_at: string;
  text: string;
  user: "user" | "assistant" | "robot" | "agent-action";
}

/** One event of a pathway call's timeline (GET /v1/pathway_calls/{id}?v=2). */
export interface BlandPathwayEvent {
  sequence: number;
  event_type: string;
  node_id: string | null;
  /** On result/error events: the sequence of the invoke they belong to. */
  operation_id: number | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

// ── Post-call data fetching ──────────────────────────────────

/**
 * Find a web agent's call_id after the call. Bland only sends the `callID`
 * WebSocket frame for pathway agents; every web call is recorded with
 * `to` = the web agent ID, and GET /v1/calls lists newest first (it has no
 * filter for `to`, so match it here).
 */
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

/** A pathway call's event timeline, in order. Calls without a pathway have none. */
export async function fetchBlandPathwayEvents(apiKey: string, callId: string): Promise<BlandPathwayEvent[]> {
  const res = await fetch(`${BLAND_API_BASE}/v1/pathway_calls/${callId}?v=2`, {
    headers: { authorization: apiKey },
  });
  if (!res.ok) throw new Error(`Bland get pathway call events failed (${res.status})`);
  const events = await res.json() as BlandPathwayEvent[];
  return events.sort((a, b) => a.sequence - b.sequence);
}

/** Bland sets `price` about 1.5 s after it marks the call completed: wait for it. */
export function isBlandCallDone(data: BlandCallResponse): boolean {
  if (data.status === "failed") return true;
  return (!!data.completed || data.status === "completed") && data.price != null;
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
 * Tool calls from Bland post-call data: a pathway's webhooks and tools from its
 * event timeline, and calls without a pathway from agent-action transcript lines.
 */
export function parseBlandToolCalls(data: BlandCallResponse, events: BlandPathwayEvent[]): ObservedToolCall[] {
  const toolCalls: ObservedToolCall[] = [];
  const callStartMs = parseBlandTimestampMs(data.started_at);

  // 1. Task agents: Bland records each tool call as an agent-action line holding only the tool's name.
  for (const entry of data.transcripts ?? []) {
    if (entry.user === "agent-action") {
      toolCalls.push({
        name: entry.text,
        arguments: {},
        timestamp_ms: toRelativeBlandTimestampMs(entry.created_at, callStartMs),
      });
    }
  }

  // 2. Pathway webhooks and tools: each invoke paired with its result or error by operation_id
  const outcomes = new Map<number, BlandPathwayEvent>();
  for (const event of events) {
    if (event.operation_id != null && /^(webhook|tool)\.(result|error)$/.test(event.event_type)) {
      outcomes.set(event.operation_id, event);
    }
  }
  for (const event of events) {
    const isWebhook = event.event_type === "webhook.invoke";
    if (!isWebhook && event.event_type !== "tool.invoke") continue;
    const invoke = event.payload ?? {};
    const outcome = outcomes.get(event.sequence);
    const out = outcome?.payload ?? {};
    const errored = outcome?.event_type.endsWith(".error") ?? false;
    const failed = errored || (isWebhook && typeof out.status === "number" && (out.status < 200 || out.status >= 300));
    const args = isWebhook ? invoke.body : invoke.input_variables;
    toolCalls.push({
      name: (typeof invoke.tool_name === "string" ? invoke.tool_name : event.node_id) ?? "webhook",
      arguments: args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {},
      result: errored ? out.message : isWebhook ? out.body : out.result,
      successful: outcome ? !failed : undefined,
      provider_tool_type: isWebhook ? "webhook" : typeof invoke.tool_type === "string" ? invoke.tool_type : undefined,
      timestamp_ms: toRelativeBlandTimestampMs(event.created_at, callStartMs),
      latency_ms: typeof out.duration_ms === "number" ? out.duration_ms : undefined,
    });
  }

  return toolCalls;
}

/** Extract call transfers from Bland post-call data. */
function extractBlandTransfers(data: BlandCallResponse): CallTransfer[] | undefined {
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
function buildBlandEndedReason(data: BlandCallResponse): string | undefined {
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
  return {
    platform: "bland",
    provider_call_id: data.call_id ?? callId ?? undefined,
    ended_reason: buildBlandEndedReason(data),
    // Bland reports only the total, so there is no breakdown.
    cost: data.price != null ? { total_usd: data.price } : undefined,
    recording_url: data.recording_url ?? undefined,
    provider_warnings: data.error_message ? [{ message: data.error_message, code: "provider_error" }] : undefined,
    transfers: extractBlandTransfers(data),
  };
}

/**
 * What Bland heard the caller say, and what its LLM wrote, in call order. A
 * pathway's timeline records what the agent actually spoke when interrupted.
 */
export function buildBlandTranscripts(data: BlandCallResponse | null, events: BlandPathwayEvent[]): PlatformUtterance[] {
  const utterances: PlatformUtterance[] = [];
  if (events.length > 0) {
    for (const event of events) {
      const text = event.payload?.text;
      if (event.event_type === "transcript.user" && typeof text === "string" && text) {
        utterances.push({ role: "caller", text });
      }
      if (event.event_type === "transcript.assistant") {
        const agentText = blandAssistantText(event.payload ?? {});
        if (agentText) utterances.push({ role: "agent", text: agentText });
      }
    }
    return utterances;
  }

  for (const entry of data?.transcripts ?? []) {
    if (entry.user === "user" || entry.user === "assistant") {
      utterances.push({ role: entry.user === "user" ? "caller" : "agent", text: stripBlandAnnotations(entry.text) });
    }
  }
  return utterances;
}

/**
 * What the agent's LLM wrote for one assistant event. `text` is what was spoken;
 * `generated_response` is the LLM's text. When it continues `text` (the same
 * sentence, cut off if the caller interrupted) it is the full version. When it
 * differs, `text` was the node's fixed message (e.g. before a webhook) and
 * `generated_response` the LLM's reply after it: both were spoken.
 */
function blandAssistantText(payload: Record<string, unknown>): string | undefined {
  const spoken = typeof payload.text === "string" ? payload.text : "";
  const generated = typeof payload.generated_response === "string" ? payload.generated_response : "";
  if (!generated) return spoken || undefined;
  if (!spoken || generated.startsWith(spoken)) return generated;
  return `${spoken} ${generated}`;
}

// ── Latency parsing ──────────────────────────────────────────

/** Parse a Bland latency message string into component timings. */
function parseLatencyMessage(msg: string): ComponentLatency | null {
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

function parseBlandTimestampMs(timestamp: string | undefined): number | undefined {
  if (!timestamp) return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toRelativeBlandTimestampMs(timestamp: string | undefined, callStartMs: number | undefined): number | undefined {
  const absoluteMs = parseBlandTimestampMs(timestamp);
  if (absoluteMs == null || callStartMs == null) return undefined;
  return Math.max(0, absoluteMs - callStartMs);
}

/** Strip Bland-injected annotations like "<Block interruptions enabled. This message was ignored>" */
function stripBlandAnnotations(text: string): string {
  return text.replace(/<[^>]*>/g, "").trim();
}
