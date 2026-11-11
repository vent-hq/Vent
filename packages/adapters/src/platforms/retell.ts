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
 *   6. getComponentTimings() — STT/LLM/TTS latencies for the whole call
 *   7. getTranscripts() — what Retell heard the caller say, and what its LLM wrote
 */

import Retell from "retell-sdk";
import type { CallResponse } from "retell-sdk/resources/call.js";
import { RetellGateway, FRAME_SAMPLES } from "./retell-gateway.js";
import { pollUntilReady, callDataUnavailableWarning } from "../shared/post-call.js";
import type { ObservedToolCall, CallMetadata, CallTransfer, ComponentLatency } from "@vent/shared";
import { BaseAudioChannel, type ComfortNoiseMode, type PlatformUtterance } from "../shared/audio-channel.js";
import { compactStringRecord } from "../shared/record-utils.js";

interface RetellAudioChannelConfig {
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
    this.gateway=new RetellGateway({
      audio: (pcm24k) => this.receiveAgentAudio(pcm24k,BaseAudioChannel.INPUT_SAMPLE_RATE),
      disconnected: () => {this.collecting=false;this.emit("disconnected");},
      error: (error) => {this._stats.errorEvents.push(error.message);this.emit("error",error);},
    });
    this.callId=await this.gateway.connect(this.config.apiKey,this.config.agentId);
    this.collecting=true;
    this._stats.connectLatencyMs=Date.now()-started;
  }

  override sendAudio(pcm: Buffer): void {
    if (!this.collecting) throw new Error("Retell gateway is not connected");
    super.sendAudio(pcm);
  }

  async disconnect(): Promise<void> {
    this.collecting=false;
    this.clearAudioBuffer();
    await this.gateway?.close();
    this.gateway=null;
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
      cost: buildRetellCost(cost),
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
      transfers: extractRetellTransfers(data),
    };
  }

  getComponentTimings(): ComponentLatency[] {
    return extractRetellComponentTimings(this.cachedCallResponse);
  }

  getTranscripts(): PlatformUtterance[] {
    // Retell lists overlapping speech out of order (a caller's last word can come after
    // the agent's reply started), so order utterances by when each one started.
    const utterances: Array<PlatformUtterance & { start: number }> = [];
    for (const entry of this.cachedCallResponse?.transcript_with_tool_calls ?? []) {
      if ((entry.role === "user" || entry.role === "agent") && "content" in entry) {
        utterances.push({
          role: entry.role === "user" ? "caller" : "agent",
          text: entry.content,
          // Without word timings, an utterance keeps its place after the previous one.
          start: entry.words?.[0]?.start ?? utterances.at(-1)?.start ?? 0,
        });
      }
    }
    return utterances.sort((a, b) => a.start - b.start).map(({ role, text }) => ({ role, text }));
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
  const resultMap = new Map<string, { content: string; successful?: boolean; timeSec?: number }>();

  for (const entry of entries) {
    if (entry["role"] === "tool_call_result" && typeof entry["tool_call_id"] === "string") {
      resultMap.set(entry["tool_call_id"], {
        content: typeof entry["content"] === "string" ? entry["content"] : "",
        successful: typeof entry["successful"] === "boolean" ? entry["successful"] : undefined,
        timeSec: typeof entry["time_sec"] === "number" ? entry["time_sec"] : undefined,
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
    // Retell stamps the invocation and its result with time_sec from call start.
    const startSec = typeof entry["time_sec"] === "number" ? entry["time_sec"] : undefined;
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
      timestamp_ms: startSec != null ? Math.round(startSec * 1000) : undefined,
      latency_ms: startSec != null && result?.timeSec != null ? Math.round((result.timeSec - startSec) * 1000) : undefined,
      provider_tool_type: typeof entry["type"] === "string" ? entry["type"] : undefined,
    });
  }

  return toolCalls;
}

/**
 * Retell reports each stage's latencies for the whole call, not per reply: one
 * STT value per caller turn, one LLM value per LLM request (a reply with a tool
 * call makes two). So they are call-level samples, one stage each. When the
 * agent opens the call, the first LLM and TTS values are its greeting, a fixed
 * message (LLM 0 ms), and are left out like other platforms' greetings.
 */
function extractRetellComponentTimings(data: CallResponse | null | undefined): ComponentLatency[] {
  const latency = data?.latency;
  if (!latency) return [];
  const greeting = data.transcript_object?.[0]?.role === "agent" ? 1 : 0;
  return [
    ...(latency.asr?.values ?? []).map((stt_ms) => ({ stt_ms })),
    ...(latency.llm?.values ?? []).slice(greeting).map((llm_ms) => ({ llm_ms })),
    ...(latency.tts?.values ?? []).slice(greeting).map((tts_ms) => ({ tts_ms })),
  ];
}

function extractRetellTransfers(data: CallResponse): CallTransfer[] | undefined {
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

function resolveRetellTransferTimestampMs(data: Pick<CallResponse, "start_timestamp" | "transfer_end_timestamp">): number | undefined {
  if (data.transfer_end_timestamp != null && data.start_timestamp != null && data.transfer_end_timestamp >= data.start_timestamp) {
    return Math.round(data.transfer_end_timestamp - data.start_timestamp);
  }
  return undefined;
}

/** Retell's own line items, keyed by its product name, in USD (Retell reports cents). */
function buildRetellCost(
  cost: { combined_cost?: number; product_costs?: Array<{ product: string; cost: number }> } | undefined,
): CallMetadata["cost"] {
  if (cost?.combined_cost == null) return undefined;
  // A product can appear twice, e.g. once more for a transfer leg. Sum in cents, then convert.
  const cents = new Map<string, number>();
  for (const item of cost.product_costs ?? []) {
    cents.set(item.product, (cents.get(item.product) ?? 0) + item.cost);
  }
  const breakdown = Object.fromEntries([...cents].map(([product, c]) => [product, c / 100]));
  return {
    total_usd: cost.combined_cost / 100,
    ...(cents.size > 0 ? { breakdown } : {}),
  };
}

