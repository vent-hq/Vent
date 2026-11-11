/**
 * Retell Audio Channel (WebRTC)
 *
 * Audio runs over WebRTC to Retell's v3 gateway (see retell-gateway.ts).
 * Results (tool calls, caller transcript, latency, cost, recording) come from
 * the Retell SDK's call.retrieve() after the call ends.
 *
 * Flow:
 *   1. connect()  — create web call v3 → gateway SDP negotiation
 *   2. sendAudio() / on("audio") — bidirectional PCM 24kHz over WebRTC (48kHz internal)
 *   3. disconnect() — closes media and deletes the gateway session
 *   4. getCallData() — tool calls
 *   5. getCallMetadata() — cost, recording, end reason, transfers
 *   6. getComponentTimings() — STT/LLM/TTS latency per turn
 *   7. getTranscripts() — what Retell heard the caller say
 */

import Retell from "retell-sdk";
import type { CallResponse } from "retell-sdk/resources/call.js";
import { RetellGateway, FRAME_SAMPLES } from "./retell-gateway.js";
import { pollUntilReady, callDataUnavailableWarning } from "../shared/post-call.js";
import type { ObservedToolCall, CallMetadata, CallTransfer, ComponentLatency, CostBreakdown, UsageEntry } from "@vent/shared";
import { BaseAudioChannel, type SendAudioOptions, type ComfortNoiseMode } from "../shared/audio-channel.js";

export interface RetellAudioChannelConfig {
  apiKey: string;
  agentId: string;
}

export class RetellAudioChannel extends BaseAudioChannel {
  /** Retell's v3 data channel only reports call status, not speaking boundaries. */
  hasPlatformEndOfTurn = false;

  private config: RetellAudioChannelConfig;
  private client: Retell;

  private gateway: RetellGateway | null = null;
  private collecting = false;

  // Call state
  private callId: string | null = null;
  private cachedCallResponse: CallResponse | null = null;
  private connectTimestamp = 0;
  private disconnectTimestamp = 0;

  // The gateway's WebRTC source takes 10ms frames of 48kHz audio, at real time.
  protected override outputSampleRate = 48000;
  protected override frameDurationMs = 10;
  protected override pacingIntervalMs = 10;
  protected override comfortNoise: ComfortNoiseMode = "silence";

  constructor(config: RetellAudioChannelConfig) {
    super();
    this.config = config;
    this.client = new Retell({ apiKey: config.apiKey });
  }

  protected async writeAudioFrame(samples: Int16Array, _sampleRate: number): Promise<void> {
    if (!this.gateway || !this.collecting) throw new Error("Retell gateway is not connected");
    // The base class sends the end-of-turn tail as one long chunk; split and pace it.
    for (let i = 0; i < samples.length; i += FRAME_SAMPLES) {
      if (i > 0) await new Promise((r) => setTimeout(r, this.frameDurationMs));
      this.gateway.writeFrame(samples.subarray(i, i + FRAME_SAMPLES));
    }
  }

  get connected(): boolean { return this.collecting; }

  async connect(): Promise<void> {
    const started=Date.now();
    this.enableRecordingCapture();
    this._connectTimestampMs=Date.now();
    this._connectMonotonicMs=performance.now();
    this.gateway=new RetellGateway({
      audio: (pcm) => {
        this._stats.bytesReceived+=pcm.length;
        this.captureAgentAudio(pcm,performance.now()-this._connectMonotonicMs);
        this.emit("audio",pcm);
      },
      disconnected: () => {this.collecting=false;this.emit("disconnected");},
      error: (error) => {this._stats.errorEvents.push(error.message);this.emit("error",error);},
    });
    this.callId=await this.gateway.connect(this.config.apiKey,this.config.agentId);
    this.collecting=true;
    this.connectTimestamp=Date.now();
    this._stats.connectLatencyMs=Date.now()-started;
  }

  /** Retell agents always speak first. */
  async getOpeningSpeaker(): Promise<"agent" | "caller" | null> {
    return "agent";
  }

  override sendAudio(pcm: Buffer, opts?: SendAudioOptions): void {
    if (!this.collecting) throw new Error("Retell gateway is not connected");
    super.sendAudio(pcm,opts);
  }

  async disconnect(): Promise<void> {
    this.collecting=false;
    this.clearAudioBuffer();
    await this.gateway?.close();
    this.gateway=null;
    this.disconnectTimestamp=Date.now();
  }

  // ── Post-call data ─────────────────────────────────────────────

  async getCallData(): Promise<ObservedToolCall[]> {
    const data = await this.fetchCallResponse();
    return data ? this.parseToolCalls(data) : [];
  }

  async getCallMetadata(): Promise<CallMetadata | null> {
    const data = await this.fetchCallResponse();
    if (!data) {
      if (!this.callId) return null;
      return {
        platform: "retell",
        provider_call_id: this.callId,
        provider_warnings: [callDataUnavailableWarning("Retell")],
      };
    }

    const cost = data.call_cost as { combined_cost?: number; product_costs?: Array<{ product: string; cost: number }> } | undefined;
    const dataRecord = data as unknown as Record<string, unknown>;
    const telephony = dataRecord["telephony_identifier"] as { twilio_call_sid?: string } | undefined;

    return {
      platform: "retell",
      provider_call_id: data.call_id ?? this.callId ?? undefined,
      provider_session_id: telephony?.twilio_call_sid,
      ended_reason: data.disconnection_reason ?? undefined,
      cost_usd: cost?.combined_cost != null ? cost.combined_cost / 100 : undefined,
      cost_breakdown: cost?.product_costs ? buildRetellCostBreakdown(cost.product_costs) : undefined,
      recording_url: data.recording_url ?? undefined,
      recording_variants: compactStringRecord({
        multi_channel: data.recording_multi_channel_url ?? undefined,
        scrubbed: data.scrubbed_recording_url ?? undefined,
        scrubbed_multi_channel: data.scrubbed_recording_multi_channel_url ?? undefined,
      }),
      provider_debug_urls: compactStringRecord({
        public_log: data.public_log_url ?? undefined,
        knowledge_base: data.knowledge_base_retrieved_contents_url ?? undefined,
      }),
      usage: buildRetellUsage(data),
      variables: data.collected_dynamic_variables ?? undefined,
      provider_metadata: compactUnknownRecord({
        duration_s: data.duration_ms != null ? data.duration_ms / 1000 : undefined,
        in_voicemail: data.call_analysis?.in_voicemail,
        telephony_identifier: telephony,
        e2e_latency: extractRetellE2eLatency(data),
      }),
      transfers: extractRetellTransfers(data),
    };
  }

  getComponentTimings(): ComponentLatency[] {
    return extractRetellComponentTimings(this.cachedCallResponse);
  }

  getTranscripts(): Array<{ turnIndex: number; text: string }> {
    const data = this.cachedCallResponse;
    const entries = data?.transcript_with_tool_calls;
    if (!entries) return [];

    const transcripts: Array<{ turnIndex: number; text: string }> = [];
    let callerTurnIndex = 0;
    for (const entry of entries) {
      if (entry.role === "user" && "content" in entry) {
        transcripts.push({ turnIndex: callerTurnIndex, text: entry.content });
        callerTurnIndex++;
      }
    }
    return transcripts;
  }

  private callData?: Promise<CallResponse | null>;

  /** One shared fetch per call: every caller waits on the same poll. */
  private fetchCallResponse(): Promise<CallResponse | null> {
    if (!this.callId) return Promise.resolve(null);
    const callId = this.callId;
    this.callData ??= pollUntilReady(
      "retell-postcall",
      () => this.client.call.retrieve(callId),
      (data) => data.call_status === "ended" || data.call_status === "error",
    ).then((data) => (this.cachedCallResponse = data));
    return this.callData;
  }


  private parseToolCalls(data: CallResponse): ObservedToolCall[] {
    const entries = (data.transcript_with_tool_calls ?? [])
      .map((entry) => entry as unknown as Record<string, unknown>);
    return parseRetellToolCallsFromEntries(entries);
  }


}

function parseRetellToolCallsFromEntries(entries: Record<string, unknown>[]): ObservedToolCall[] {
  const toolCalls: ObservedToolCall[] = [];
  const resultMap = new Map<string, { content: string; successful?: boolean }>();

  for (const entry of entries) {
    if (entry["role"] === "tool_call_result" && typeof entry["tool_call_id"] === "string") {
      resultMap.set(entry["tool_call_id"], {
        content: typeof entry["content"] === "string" ? entry["content"] : "",
        successful: typeof entry["successful"] === "boolean" ? entry["successful"] : undefined,
      });
    }
  }

  for (const entry of entries) {
    if (entry["role"] !== "tool_call_invocation") continue;
    const toolCallId = typeof entry["tool_call_id"] === "string" ? entry["tool_call_id"] : undefined;
    const name = typeof entry["name"] === "string" ? entry["name"] : undefined;
    if (!toolCallId || !name) continue;

    let args: Record<string, unknown> = {};
    if (typeof entry["arguments"] === "string") {
      try {
        args = JSON.parse(entry["arguments"]) as Record<string, unknown>;
      } catch {
        args = {};
      }
    }

    const result = resultMap.get(toolCallId);
    let parsedResult: unknown;
    if (result) {
      try {
        parsedResult = JSON.parse(result.content);
      } catch {
        parsedResult = result.content;
      }
    }

    toolCalls.push({
      name,
      arguments: args,
      result: parsedResult,
      successful: result?.successful,
      provider_tool_type: typeof entry["type"] === "string"
        ? entry["type"]
        : typeof entry["tool_type"] === "string"
          ? entry["tool_type"]
          : undefined,
    });
  }

  return toolCalls;
}

export function extractRetellComponentTimings(data: CallResponse | null | undefined): ComponentLatency[] {
  if (!data?.latency) return [];
  const lat = data.latency as Record<string, { values?: number[] } | undefined>;
  const sttValues = lat.asr?.values ?? [];
  const llmValues = lat.llm?.values ?? [];
  const ttsValues = lat.tts?.values ?? [];
  const maxLen = Math.max(sttValues.length, llmValues.length, ttsValues.length);
  if (maxLen === 0) return [];
  const timings: ComponentLatency[] = [];
  for (let i = 0; i < maxLen; i++) {
    timings.push({
      stt_ms: sttValues[i],
      llm_ms: llmValues[i],
      tts_ms: ttsValues[i],
    });
  }
  return timings;
}

function extractRetellE2eLatency(data: CallResponse): Record<string, unknown> | undefined {
  const lat = data.latency as Record<string, { p50?: number; p90?: number; p95?: number; p99?: number; min?: number; max?: number; num?: number } | undefined> | undefined;
  const e2e = lat?.e2e;
  if (!e2e) return undefined;
  return {
    p50_ms: e2e.p50,
    p90_ms: e2e.p90,
    p95_ms: e2e.p95,
    p99_ms: e2e.p99,
    min_ms: e2e.min,
    max_ms: e2e.max,
    num_turns: e2e.num,
  };
}

export function extractRetellTransfers(data: CallResponse): CallTransfer[] | undefined {
  const disconnectionReason = data.disconnection_reason ?? undefined;
  const destination = data.transfer_destination ?? undefined;
  const looksTransferred =
    destination != null
    || disconnectionReason === "call_transfer"
    || disconnectionReason === "transfer_bridged"
    || disconnectionReason === "transfer_cancelled";

  if (!looksTransferred) return undefined;

  const status = resolveRetellTransferStatus(data);
  const transfer: CallTransfer = {
    type: disconnectionReason ?? "call_transfer",
    destination,
    status,
    sources: ["platform_metadata"],
  };
  const timestampMs = resolveRetellTransferTimestampMs(data);
  if (timestampMs != null) {
    transfer.timestamp_ms = timestampMs;
  }
  return [transfer];
}

function resolveRetellTransferStatus(data: Pick<CallResponse, "disconnection_reason" | "transfer_end_timestamp" | "transfer_destination">): CallTransfer["status"] {
  const reason = data.disconnection_reason ?? undefined;
  if (reason === "transfer_bridged") return "completed";
  if (reason === "transfer_cancelled") return "cancelled";
  if (reason === "call_transfer" && data.transfer_end_timestamp != null) return "completed";
  if (reason === "call_transfer" || data.transfer_destination != null) return "attempted";
  return "unknown";
}

export function resolveRetellTransferTimestampMs(data: Pick<CallResponse, "start_timestamp" | "transfer_end_timestamp">): number | undefined {
  if (data.transfer_end_timestamp != null && data.start_timestamp != null && data.transfer_end_timestamp >= data.start_timestamp) {
    return Math.round(data.transfer_end_timestamp - data.start_timestamp);
  }
  return undefined;
}

export function buildRetellCostBreakdown(products: Array<{ product: string; cost: number }>): CostBreakdown {
  const breakdown: CostBreakdown = {};
  let total = 0;
  for (const p of products) {
    const usd = p.cost / 100;
    total += usd;
    const name = p.product.toLowerCase();
    if (name.includes("stt") || name.includes("asr") || name.includes("deepgram") || name.includes("whisper")) {
      breakdown.stt_usd = (breakdown.stt_usd ?? 0) + usd;
    } else if (name.includes("tts") || name.includes("elevenlabs") || name.includes("playht") || name.includes("cartesia")) {
      breakdown.tts_usd = (breakdown.tts_usd ?? 0) + usd;
    } else if (name.includes("llm") || name.includes("gpt") || name.includes("claude") || name.includes("openai")) {
      breakdown.llm_usd = (breakdown.llm_usd ?? 0) + usd;
    } else if (name.includes("transport") || name.includes("telephony") || name.includes("twilio")) {
      breakdown.transport_usd = (breakdown.transport_usd ?? 0) + usd;
    } else if (name.includes("retell") || name.includes("platform")) {
      breakdown.platform_usd = (breakdown.platform_usd ?? 0) + usd;
    }
  }
  breakdown.total_usd = total;
  return breakdown;
}

function buildRetellUsage(data: CallResponse): UsageEntry[] | undefined {
  const tokenUsage = data.llm_token_usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  if (!tokenUsage) return undefined;
  if (!tokenUsage.prompt_tokens && !tokenUsage.completion_tokens) return undefined;

  // Try to get model name from the call config
  const dataRecord = data as unknown as Record<string, unknown>;
  const llmId = (dataRecord["llm_id"] as string | undefined)
    ?? (dataRecord["agent_id"] as string | undefined)
    ?? "";

  return [{
    type: "llm_usage",
    provider: "retell",
    model: llmId,
    input_tokens: tokenUsage.prompt_tokens,
    output_tokens: tokenUsage.completion_tokens,
  }];
}

function compactStringRecord(record: Record<string, string | undefined>): Record<string, string> | undefined {
  const compacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.length > 0) {
      compacted[key] = value;
    }
  }
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function compactUnknownRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value != null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
