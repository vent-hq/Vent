/**
 * Vapi Audio Channel
 *
 * Creates a call via Vapi's API with WebSocket transport, exchanges
 * binary PCM audio, and pulls tool call data after the call via GET /call/{id}.
 *
 * Audio format: PCM 16-bit signed little-endian, 16kHz (Vapi's native WS format).
 * Resampling from 24kHz→16kHz on send, 16kHz→24kHz on receive.
 *
 * Results (tool calls, caller transcript, STT/LLM/TTS latency, cost, recording)
 * come from GET /call/{id} after the call. Live WebSocket text frames are only
 * used while the call runs: agent speech start, tool-call-in-progress, and end.
 */

import { gunzipSync } from "node:zlib";
import { VapiClient, type Vapi } from "@vapi-ai/server-sdk";
import type { ObservedToolCall, CallMetadata, CallTransfer, ComponentLatency } from "@vent/shared";
import { WebSocketAudioChannel } from "../shared/websocket-channel.js";
import type { PlatformUtterance } from "../shared/audio-channel.js";
import { pollUntilReady, callDataUnavailableWarning } from "../shared/post-call.js";
import { compactNumberRecord, compactStringRecord } from "../shared/record-utils.js";

interface VapiAudioChannelConfig {
  apiKey: string;
  assistantId: string;
}

interface VapiAssistantRuntimeConfig {
  firstMessageMode?: string;
  firstMessage?: string;
  maxDurationSeconds?: number;
}

interface VapiCallMessage {
  role: string;
  message?: string;
  toolCalls?: Array<{
    id: string;
    type?: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  toolCallId?: string;
  result?: string;
  secondsFromStart?: number;
}

interface VapiTurnLatency {
  transcriberLatency?: number;
  modelLatency?: number;
  voiceLatency?: number;
}

interface VapiCallResponse {
  id: string;
  status: string;
  endedReason?: string;
  duration?: number;
  costBreakdown?: {
    stt?: number;
    llm?: number;
    tts?: number;
    transport?: number;
    vapi?: number;
    chat?: number;
    total?: number;
    analysisCostBreakdown?: {
      summary?: number;
      structuredData?: number;
      successEvaluation?: number;
      structuredOutput?: number;
    };
  };
  artifact?: {
    messages?: VapiCallMessage[];
    recording?: { stereoUrl?: string; videoUrl?: string; mono?: { combinedUrl?: string } };
    recordingUrl?: string;
    stereoRecordingUrl?: string;
    videoRecordingUrl?: string;
    pcapUrl?: string;
    logUrl?: string;
    performanceMetrics?: { turnLatencies?: VapiTurnLatency[] } & Record<string, unknown>;
  };
}

const TOOL_RESULT_PENDING_SENTINEL = "Tool Result Still Pending But Proceed Further If Possible.";

export class VapiAudioChannel extends WebSocketAudioChannel {
  protected readonly label = "Vapi";
  protected override outputSampleRate = 16000;
  protected override agentSampleRate = 16000;

  private config: VapiAudioChannelConfig;
  private callId: string | null = null;
  private controlUrl: string | null = null;
  private cachedCallResponse: VapiCallResponse | null = null;
  private cachedAssistantRuntimeConfig: VapiAssistantRuntimeConfig | null | undefined;

  /** Vapi speech-update is useful for turn correlation, but not reliable enough as the
   *  runtime end-of-turn source. Vent keeps VAD as the authority for Vapi turn endings. */
  hasPlatformEndOfTurn = false;

  // Tool call tracking — cleared when conversation history shows the real tool result.
  private toolCallStartedAt = 0;
  private pendingToolCallIds = new Set<string>();
  // Collected live: Vapi's stored call messages hold a transcription of the
  // agent's audio, not the text it was set to say.
  private liveTranscript: PlatformUtterance[] = [];
  private toolDurations = new Map<string, number>();

  constructor(config: VapiAudioChannelConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();

    // Create call via Vapi SDK with WebSocket transport. The customer's saved
    // assistant runs unmodified, so measured timing matches what their callers get.
    const client = new VapiClient({ token: this.config.apiKey });

    const callResponse = await client.calls.create({
      assistantId: this.config.assistantId,
      transport: {
        provider: "vapi.websocket",
        audioFormat: {
          format: "pcm_s16le",
          container: "raw",
          sampleRate: 16000,
        },
      },
    });
    // SDK returns Call | CallBatchResponse — we always create a single call
    const callData = callResponse as Vapi.Call;

    // Cast to access fields not yet in SDK types
    const rawCall = callData as unknown as Record<string, unknown>;
    this.callId = callData.id;
    this.controlUrl = callData.monitor?.controlUrl ?? null;

    const subLimits = rawCall.subscriptionLimits as { concurrencyLimit?: number; concurrencyBlocked?: boolean } | undefined;
    if (subLimits?.concurrencyBlocked) {
      throw new Error(
        `Vapi concurrency limit reached (${subLimits.concurrencyLimit} concurrent calls). ` +
        `Increase your limit at Vapi Dashboard > Billings & Add-ons.`
      );
    }

    const wsUrl = (callData.transport as Record<string, unknown> | undefined)?.websocketCallUrl as string | undefined;

    if (!wsUrl) {
      throw new Error("Vapi response missing websocketCallUrl");
    }

    // Connect for audio exchange. Vapi's first server message proves the call is fully provisioned.
    await this.openSocket(wsUrl, {}, (text) => this.handleControlMessage(text), true);
    this._stats.connectLatencyMs = Date.now() - connectStart;

    // Start comfort noise to keep the WebSocket active while waiting for agent greeting
    this.startComfortNoise();
  }

  async disconnect(): Promise<void> {
    this.stopComfortNoise();
    this.clearToolCallActive("Call disconnected before tool result arrived");
    // End the call on Vapi's side by sending end-call over WebSocket.
    // Per Vapi docs: send {"type": "end-call"} as a text frame to terminate the call cleanly.
    // Also try controlUrl as fallback for cases where WS is already closed.
    if (this.ws && this.connected) {
      try {
        this.ws.send(JSON.stringify({ type: "end-call" }));
      } catch {
        // Non-fatal — WS may be closing
      }
    } else if (this.controlUrl) {
      try {
        await fetch(this.controlUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "end-call" }),
        });
      } catch {
        // Non-fatal — call may already be ended
      }
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private async getAssistantRuntimeConfig(): Promise<VapiAssistantRuntimeConfig | null> {
    if (this.cachedAssistantRuntimeConfig !== undefined) {
      return this.cachedAssistantRuntimeConfig;
    }

    try {
      const client = new VapiClient({ token: this.config.apiKey });
      const raw = await client.assistants.get({ id: this.config.assistantId }) as unknown as Record<string, unknown>;

      const config = {
        firstMessageMode: raw.firstMessageMode as string | undefined,
        firstMessage: raw.firstMessage as string | undefined,
        maxDurationSeconds: raw.maxDurationSeconds as number | undefined,
      };
      this.cachedAssistantRuntimeConfig = config;
      return config;
    } catch {
      this.cachedAssistantRuntimeConfig = null;
      return null;
    }
  }

  async getOpeningSpeaker(): Promise<"agent" | "caller" | null> {
    const config = await this.getAssistantRuntimeConfig();
    if (!config) return null;

    switch (config.firstMessageMode) {
      case "assistant-speaks-first":
      case "assistant-speaks-first-with-model-generated-message":
        return "agent";
      case "assistant-waits-for-user":
        return "caller";
      default:
        return "agent";
    }
  }

  async getMaxCallDurationSeconds(): Promise<number | null> {
    const config = await this.getAssistantRuntimeConfig();
    return config?.maxDurationSeconds ?? null;
  }

  // ── Post-call data (GET /call/{id}) ─────────────────────────

  async getCallData(): Promise<ObservedToolCall[]> {
    const data = await this.fetchCallResponse();
    return data ? parseToolCalls(data, this.toolDurations) : [];
  }

  async getCallMetadata(): Promise<CallMetadata | null> {
    const data = await this.fetchCallResponse();
    if (!data) {
      if (!this.callId) return null;
      return {
        platform: "vapi",
        provider_call_id: this.callId,
        provider_warnings: [callDataUnavailableWarning("Vapi")],
      };
    }

    const cb = data.costBreakdown;
    const toolCalls = parseToolCalls(data, this.toolDurations);
    return {
      platform: "vapi",
      provider_call_id: data.id || this.callId || undefined,
      ended_reason: data.endedReason,
      cost: buildVapiCost(cb),
      recording_url: getPrimaryRecordingUrl(data.artifact),
      recording_variants: buildVapiRecordingVariants(data.artifact),
      provider_debug_urls: buildVapiDebugUrls(data),
      transfers: extractVapiTransfers(toolCalls, data.endedReason),
    };
  }

  /** Vapi's own per-response STT/LLM/TTS latency, one entry per agent reply. */
  getComponentTimings(): ComponentLatency[] {
    const turns = this.cachedCallResponse?.artifact?.performanceMetrics?.turnLatencies ?? [];
    return turns.map((turn) => ({
      stt_ms: turn.transcriberLatency,
      llm_ms: turn.modelLatency,
      tts_ms: turn.voiceLatency,
    }));
  }

  /** What Vapi heard the caller say, and the text it sent to the voice, in call order. */
  getTranscripts(): PlatformUtterance[] {
    // Vapi starts a fixed first message (the default mode) before Vent's socket connects and
    // sends no voice-input for it; its text is the assistant's firstMessage. Vapi reports the
    // text of its tool wait messages ("Just a sec") nowhere, so those are missing.
    const config = this.cachedAssistantRuntimeConfig;
    const fixedFirstMessage = (config?.firstMessageMode ?? "assistant-speaks-first") === "assistant-speaks-first"
      ? config?.firstMessage
      : undefined;
    return fixedFirstMessage ? [{ role: "agent", text: fixedFirstMessage }, ...this.liveTranscript] : this.liveTranscript;
  }

  private callData?: Promise<VapiCallResponse | null>;

  /** One shared fetch per call. Everything appears together once status is "ended". */
  private fetchCallResponse(): Promise<VapiCallResponse | null> {
    if (!this.callId) return Promise.resolve(null);
    const callId = this.callId;
    const client = new VapiClient({ token: this.config.apiKey });
    this.callData ??= pollUntilReady(
      "vapi-postcall",
      async () => await client.calls.get({ id: callId }) as unknown as VapiCallResponse,
      (data) => data.status === "ended",
    ).then(async (data) => {
      this.cachedCallResponse = data;
      if (data) this.toolDurations = await fetchVapiToolDurations(this.config.apiKey, callId);
      return data;
    });
    return this.callData;
  }


  // ── Tool-call-in-progress tracking (live) ───────────────────

  private clearToolCallActive(reason: string): void {
    if (this.toolCallStartedAt === 0) return;
    console.log(`    [vapi] ${reason} (${Date.now() - this.toolCallStartedAt}ms after tool-calls) — clearing toolCallActive`);
    this.toolCallStartedAt = 0;
    this.pendingToolCallIds.clear();
    this.emit("toolCallActive", false);
  }

  private maybeResolveToolCall(msg: Record<string, unknown>): void {
    if (this.toolCallStartedAt === 0) return;

    const resolvedIds = this.extractResolvedToolCallIds(msg);
    if (resolvedIds.size === 0) return;

    if (this.pendingToolCallIds.size === 0) {
      this.clearToolCallActive("Conversation update contains resolved tool result(s)");
      return;
    }

    for (const id of resolvedIds) {
      this.pendingToolCallIds.delete(id);
    }

    if (this.pendingToolCallIds.size === 0) {
      this.clearToolCallActive("Conversation update contains resolved tool result(s)");
    } else {
      console.log(`    [vapi] Tool results received for ${resolvedIds.size} call(s); still waiting on ${this.pendingToolCallIds.size}`);
    }
  }

  /** Ids of tools whose result is in a `conversation-update`; an async tool's placeholder result doesn't count. */
  private extractResolvedToolCallIds(msg: Record<string, unknown>): Set<string> {
    const resolved = new Set<string>();
    for (const message of (msg.messages ?? []) as VapiCallMessage[]) {
      if (message.role === "tool_call_result" && message.toolCallId && !message.result?.includes(TOOL_RESULT_PENDING_SENTINEL)) {
        resolved.add(message.toolCallId);
      }
    }
    return resolved;
  }


  private handleControlMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch (e) {
      this._stats.errorEvents.push(`Malformed control message: ${(e as Error).message}`);
      return;
    }

    const type = msg.type as string | undefined;
    if (!type) return;

    const now = Date.now();

    switch (type) {
      case "speech-update": {
        if (msg.role !== "assistant" || msg.status !== "started") break;
        this.emit("platformSpeechStart");
        break;
      }

      case "tool-calls": {
        // The agent is running a tool: turn detection must not end its turn on the silence.
        // Cleared once conversation history includes the real tool result.
        const toolCallList = msg.toolCallList as Array<Record<string, unknown>> | undefined;
        if (!toolCallList) break;
        this.toolCallStartedAt = now;
        this.pendingToolCallIds = new Set(
          toolCallList
            .map((tc) => typeof tc.id === "string" ? tc.id : "")
            .filter(Boolean)
        );
        console.log(`    [vapi] Tool call detected: ${toolCallList.map(tc => (tc.function as Record<string, unknown>)?.name).join(", ")} — suspending VAD until tool result arrives`);
        this.emit("toolCallActive", true);
        break;
      }

      case "conversation-update":
        this.maybeResolveToolCall(msg);
        break;

      case "transcript":
        if (msg.role === "user" && msg.transcriptType === "final" && typeof msg.transcript === "string") {
          this.liveTranscript.push({ role: "caller", text: msg.transcript });
        }
        break;

      case "voice-input":
        if (typeof msg.input === "string") this.liveTranscript.push({ role: "agent", text: msg.input });
        break;

      case "status-update":
        if (msg.status === "ended") this.emit("disconnected");
        break;

      case "hang":
        this._stats.errorEvents.push(`Vapi hang event: ${JSON.stringify(msg)}`);
        break;
    }
  }
}

/**
 * How long each tool ran, from the call's logs (GET /call/{id}/call-logs, gzipped
 * JSONL). The call record only shows when a result joined the conversation, which
 * waits for the "one moment" message to finish playing. A run of several tools has
 * one duration, so only single-tool runs are kept. Without logs (Logging off): none.
 */
async function fetchVapiToolDurations(apiKey: string, callId: string): Promise<Map<string, number>> {
  const durations = new Map<string, number>();
  const res = await fetch(`https://api.vapi.ai/call/${callId}/call-logs`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return durations;
  const lines = gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8").split("\n");
  for (const line of lines) {
    if (!line) continue;
    const { attributes } = JSON.parse(line) as {
      attributes?: { event?: string; duration?: number; results?: Array<{ toolCallId: string }> };
    };
    // `duration` covers the whole batch, so it is one call's latency only when the batch held one call.
    if (attributes?.event !== "assistant.tool.completed" || attributes.results?.length !== 1) continue;
    if (typeof attributes.duration === "number") durations.set(attributes.results[0]!.toolCallId, attributes.duration);
  }
  return durations;
}

function parseToolCalls(data: VapiCallResponse, toolDurations: Map<string, number>): ObservedToolCall[] {
  const messages = data.artifact?.messages ?? [];
  const toolCalls: ObservedToolCall[] = [];

  // Build a map of tool call results keyed by toolCallId
  // Vapi format: { role: "tool_call_result", toolCallId: "...", result: "..." }
  const resultMap = new Map<string, { result?: string }>();
  for (const msg of messages) {
    if (msg.role === "tool_call_result" && msg.toolCallId) {
      resultMap.set(msg.toolCallId, { result: msg.result });
    }
  }

  for (const msg of messages) {
    if (msg.role === "tool_calls" && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          // keep empty
        }

        const resultEntry = resultMap.get(tc.id);

        let parsedResult: unknown;
        try {
          parsedResult = resultEntry?.result ? JSON.parse(resultEntry.result) : undefined;
        } catch {
          parsedResult = resultEntry?.result;
        }

        const timestampMs = msg.secondsFromStart != null ? msg.secondsFromStart * 1000 : undefined;
        const hasResult = resultEntry != null;

        toolCalls.push({
          name: tc.function.name,
          arguments: args,
          result: parsedResult,
          successful: hasResult,
          provider_tool_type: tc.type,
          timestamp_ms: timestampMs,
          latency_ms: toolDurations.get(tc.id),
        });
      }
    }
  }

  return toolCalls;
}

/**
 * Transfers from Vapi post-call data: calls to the built-in transferCall tool,
 * else an "assistant-forwarded-call" end reason.
 */
function extractVapiTransfers(toolCalls: ObservedToolCall[], endedReason: string | undefined): CallTransfer[] | undefined {
  const forwarded = endedReason === "assistant-forwarded-call";
  const transfers: CallTransfer[] = toolCalls
    .filter((toolCall) => toolCall.name === "transferCall")
    .map((toolCall) => ({
      type: "transferCall",
      // The model passes the stored number or SIP URI it picked as `destination`.
      destination: typeof toolCall.arguments.destination === "string" ? toolCall.arguments.destination : undefined,
      status: forwarded ? "completed" : "attempted",
      sources: ["platform_metadata"],
      ...(toolCall.timestamp_ms != null ? { timestamp_ms: toolCall.timestamp_ms } : {}),
    }));

  if (transfers.length === 0 && forwarded) {
    transfers.push({
      type: "assistant-forwarded-call",
      status: "completed",
      sources: ["platform_metadata"],
    });
  }

  return transfers.length > 0 ? transfers : undefined;
}

/** Vapi's own cost categories, in USD. The analysis sub-costs are summed into `analysis`. */
function buildVapiCost(costBreakdown: VapiCallResponse["costBreakdown"] | undefined): CallMetadata["cost"] {
  if (costBreakdown?.total == null) return undefined;
  const analysisCosts = Object.values(costBreakdown.analysisCostBreakdown ?? {})
    .filter((v): v is number => typeof v === "number");
  const breakdown = compactNumberRecord({
    stt: costBreakdown.stt,
    llm: costBreakdown.llm,
    tts: costBreakdown.tts,
    transport: costBreakdown.transport,
    vapi: costBreakdown.vapi,
    chat: costBreakdown.chat,
    analysis: analysisCosts.length > 0 ? analysisCosts.reduce((a, b) => a + b, 0) : undefined,
  });
  return { total_usd: costBreakdown.total, ...(breakdown ? { breakdown } : {}) };
}

function getPrimaryRecordingUrl(artifact: VapiCallResponse["artifact"] | undefined): string | undefined {
  if (!artifact) return undefined;
  return artifact.recordingUrl ?? artifact.stereoRecordingUrl ?? artifact.videoRecordingUrl;
}

function buildVapiRecordingVariants(artifact: VapiCallResponse["artifact"] | undefined): CallMetadata["recording_variants"] {
  if (!artifact) return undefined;
  return compactStringRecord({
    primary: artifact.recordingUrl,
    mono: artifact.recording?.mono?.combinedUrl,
    stereo: artifact.stereoRecordingUrl,
    video: artifact.videoRecordingUrl,
  });
}

/** Links that still work after the call; the live monitor sockets don't. */
function buildVapiDebugUrls(
  data: Pick<VapiCallResponse, "id" | "artifact">,
): CallMetadata["provider_debug_urls"] {
  return compactStringRecord({
    dashboard: data.id ? `https://dashboard.vapi.ai/calls/${data.id}` : undefined,
    log: data.artifact?.logUrl,
    pcap: data.artifact?.pcapUrl,
  });
}
