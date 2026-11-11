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

import WebSocket from "ws";
import { VapiClient, type Vapi } from "@vapi-ai/server-sdk";
import type { ObservedToolCall, CallMetadata, CallTransfer, ComponentLatency, UsageEntry } from "@vent/shared";
import { resample } from "@vent/voice";
import { BaseAudioChannel, CONNECT_TIMEOUT_MS } from "../shared/audio-channel.js";
import { pollUntilReady, callDataUnavailableWarning } from "../shared/post-call.js";

export interface VapiAudioChannelConfig {
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
    id?: string;
    type?: string;
    function: {
      name: string;
      arguments: string;
      type?: string;
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
  monitor?: {
    listenUrl?: string;
    controlUrl?: string;
  };
  costBreakdown?: {
    stt?: number;
    llm?: number;
    tts?: number;
    transport?: number;
    vapi?: number;
    chat?: number;
    total?: number;
    llmPromptTokens?: number;
    llmCompletionTokens?: number;
    llmCachedPromptTokens?: number;
    ttsCharacters?: number;
    analysisCostBreakdown?: Record<string, unknown>;
  };
  analysis?: {
    summary?: string;
    successEvaluation?: string;
    structuredData?: Record<string, unknown>;
    structuredDataMulti?: Array<Record<string, unknown>>;
  };
  artifact?: {
    messages?: VapiCallMessage[];
    messagesOpenAIFormatted?: unknown[];
    transcript?: string;
    recording?: unknown;
    recordingUrl?: string;
    stereoRecordingUrl?: string;
    videoRecordingUrl?: string;
    pcapUrl?: string;
    logUrl?: string;
    nodes?: unknown[];
    variableValues?: Record<string, unknown>;
    performanceMetrics?: { turnLatencies?: VapiTurnLatency[] } & Record<string, unknown>;
    structuredOutputs?: Record<string, unknown>;
    scorecards?: Record<string, unknown>;
  };
  assistant?: {
    model?: {
      provider?: string;
      model?: string;
    };
  };
}

type VapiToolCall = NonNullable<VapiCallMessage["toolCalls"]>[number];

const TOOL_RESULT_PENDING_SENTINEL = "Tool Result Still Pending But Proceed Further If Possible.";


export class VapiAudioChannel extends BaseAudioChannel {
  protected override outputSampleRate = 16000;
  protected override pacingIntervalMs = 10; // 2x real-time (Pipecat: chunk_duration / 2)

  private config: VapiAudioChannelConfig;
  private ws: WebSocket | null = null;
  private callId: string | null = null;
  private controlUrl: string | null = null;
  private cachedCallResponse: VapiCallResponse | null = null;
  private cachedAssistantRuntimeConfig: VapiAssistantRuntimeConfig | null | undefined;

  /** Vapi speech-update is useful for turn correlation, but not reliable enough as the
   *  runtime end-of-turn source. Vent keeps VAD as the authority for Vapi turn endings. */
  hasPlatformEndOfTurn = false;

  // Call start timestamp for relative timing
  private connectTimestamp = 0;

  // Tool call tracking — cleared when conversation history shows the real tool result.
  private toolCallStartedAt = 0;
  private pendingToolCallIds = new Set<string>();

  constructor(config: VapiAudioChannelConfig) {
    super();
    this.config = config;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();
    this.connectTimestamp = connectStart;
    this._connectTimestampMs = connectStart;
    this._connectMonotonicMs = performance.now();
    this.enableRecordingCapture();

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

    // Connect to WebSocket for audio exchange.
    await this.connectWebSocket(wsUrl);
    this._stats.connectLatencyMs = Date.now() - connectStart;

    // Start comfort noise to keep the WebSocket active while waiting for agent greeting
    this.startComfortNoise();
  }

  protected async writeAudioFrame(samples: Int16Array, sampleRate: number): Promise<void> {
    if (!this.ws) return;
    this.ws.send(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  }

  override sendAudio(pcm: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Vapi WebSocket not connected");
    }
    super.sendAudio(pcm);
  }

  async disconnect(): Promise<void> {
    this.stopComfortNoise();
    this.clearToolCallActive("Call disconnected before tool result arrived");
    // End the call on Vapi's side by sending end-call over WebSocket.
    // Per Vapi docs: send {"type": "end-call"} as a text frame to terminate the call cleanly.
    // Also try controlUrl as fallback for cases where WS is already closed.
    if (this.ws?.readyState === WebSocket.OPEN) {
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
    return data ? parseToolCalls(data) : [];
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
    return {
      platform: "vapi",
      provider_call_id: data.id || this.callId || undefined,
      ended_reason: data.endedReason,
      cost_usd: cb?.total,
      cost_breakdown: buildVapiCostBreakdown(cb),
      usage: buildVapiUsage(cb, data.assistant),
      recording_url: getPrimaryRecordingUrl(data.artifact),
      recording_variants: buildVapiRecordingVariants(data.artifact),
      provider_debug_urls: buildVapiDebugUrls(data),
      variables: data.artifact?.variableValues,
      provider_metadata: compactUnknownRecord({
        duration_s: data.duration,
        performance_metrics: data.artifact?.performanceMetrics,
      }),
      transfers: extractVapiTransfers(data),
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

  /** What Vapi heard the caller say, in order, one entry per caller message. */
  getTranscripts(): Array<{ turnIndex: number; text: string }> {
    const messages = this.cachedCallResponse?.artifact?.messages ?? [];
    return messages
      .filter((message) => message.role === "user" && message.message)
      .map((message, turnIndex) => ({ turnIndex, text: message.message! }));
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
    ).then((data) => (this.cachedCallResponse = data));
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

    if (resolvedIds.has("__unknown__") || this.pendingToolCallIds.size === 0) {
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

  private extractResolvedToolCallIds(msg: Record<string, unknown>): Set<string> {
    const resolved = new Set<string>();
    const artifact = msg.artifact as Record<string, unknown> | undefined;
    const sources = [
      msg.messages,
      artifact?.messages,
      msg.messagesOpenAIFormatted,
      artifact?.messagesOpenAIFormatted,
    ];

    for (const source of sources) {
      if (!Array.isArray(source)) continue;

      for (const entry of source) {
        if (!entry || typeof entry !== "object") continue;
        const message = entry as Record<string, unknown>;
        const role = typeof message.role === "string" ? message.role : "";

        if (role === "tool_call_result") {
          const toolCallId = typeof message.toolCallId === "string"
            ? message.toolCallId
            : typeof message.tool_call_id === "string"
              ? message.tool_call_id
              : "";
          resolved.add(toolCallId || "__unknown__");
          continue;
        }

        if (role === "tool") {
          const content = typeof message.content === "string"
            ? message.content
            : typeof message.result === "string"
              ? message.result
              : "";
          if (!content || content.includes(TOOL_RESULT_PENDING_SENTINEL)) continue;

          const toolCallId = typeof message.tool_call_id === "string"
            ? message.tool_call_id
            : typeof message.toolCallId === "string"
              ? message.toolCallId
              : "";
          resolved.add(toolCallId || "__unknown__");
        }
      }
    }

    return resolved;
  }

  private async connectWebSocket(wsUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "nodebuffer";
      let resolved = false;

      // Timeout if WebSocket doesn't complete handshake
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ws.close();
          reject(new Error(`Vapi WebSocket connection timed out after ${CONNECT_TIMEOUT_MS}ms`));
        }
      }, CONNECT_TIMEOUT_MS);

      ws.on("open", () => {
        this.ws = ws;
        console.log(`    [vapi-ws] open t=${this.relativeNowMs()}ms`);

        ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
          if (isBinary) {
            const chunk = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
            this._stats.bytesReceived += chunk.length;
            const resampled = resample(chunk, 16000, 24000);
            this.captureAgentAudio(resampled, performance.now() - this._connectMonotonicMs);
            this.emit("audio", resampled);
          } else {
            this.handleControlMessage(data.toString());

            // Resolve on first server message — proves the call is fully provisioned
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              resolve();
            }
          }
        });

        ws.on("error", (err) => {
          this._stats.errorEvents.push(err.message);
          this.emit("error", err);
        });

        ws.on("close", () => {
          this.stopComfortNoise();
          this.ws = null;
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            reject(new Error("Vapi WebSocket closed before call was provisioned"));
            return;
          }
          this.emit("disconnected");
        });
      });

      ws.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`Vapi WebSocket connection failed: ${err.message}`));
        }
      });
    });
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

      case "status-update":
        if (msg.status === "ended") this.emit("disconnected");
        break;

      case "hang":
        this._stats.errorEvents.push(`Vapi hang event: ${JSON.stringify(msg)}`);
        break;
    }
  }

  private relativeNowMs(): number {
    return this.connectTimestamp > 0 ? Date.now() - this.connectTimestamp : 0;
  }
}

function parseToolCalls(data: VapiCallResponse): ObservedToolCall[] {
  const messages = data.artifact?.messages ?? [];
  const toolCalls: ObservedToolCall[] = [];

  // Build a map of tool call results keyed by toolCallId
  // Vapi format: { role: "tool_call_result", toolCallId: "...", result: "..." }
  const resultMap = new Map<string, { result?: string; secondsFromStart?: number }>();
  const resultsByPosition: Array<{ result?: string; secondsFromStart?: number }> = [];
  for (const msg of messages) {
    if (msg.role === "tool_call_result" && msg.toolCallId) {
      const entry = { result: msg.result, secondsFromStart: msg.secondsFromStart };
      resultMap.set(msg.toolCallId, entry);
      resultsByPosition.push(entry);
    }
  }

  let toolCallIndex = 0;
  for (const msg of messages) {
    if ((msg.role === "tool_calls" || msg.role === "tool-call") && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          // keep empty
        }

        // Try ID match first, fall back to positional match
        let resultEntry = tc.id ? resultMap.get(tc.id) : undefined;
        if (!resultEntry && toolCallIndex < resultsByPosition.length) {
          console.log(`    [vapi-postcall] Tool call "${tc.function.name}" ID "${tc.id}" not in resultMap (${resultMap.size} entries), using positional match`);
          resultEntry = resultsByPosition[toolCallIndex];
        }

        let parsedResult: unknown;
        try {
          parsedResult = resultEntry?.result ? JSON.parse(resultEntry.result) : undefined;
        } catch {
          parsedResult = resultEntry?.result;
        }

        const timestampMs = msg.secondsFromStart != null ? msg.secondsFromStart * 1000 : undefined;
        const resultTimestampMs = resultEntry?.secondsFromStart != null ? resultEntry.secondsFromStart * 1000 : undefined;
        const hasResult = resultEntry != null;

        toolCalls.push({
          name: tc.function.name,
          arguments: args,
          result: parsedResult,
          successful: hasResult,
          provider_tool_type: typeof tc.type === "string"
            ? tc.type
            : typeof tc.function.type === "string"
              ? tc.function.type
              : undefined,
          timestamp_ms: timestampMs,
          latency_ms: timestampMs != null && resultTimestampMs != null ? resultTimestampMs - timestampMs : undefined,
        });
        toolCallIndex++;
      }
    }
  }

  return toolCalls;
}

/**
 * Extract transfers from Vapi post-call API data.
 * Looks at transferCall tool calls in artifact.messages and endedReason.
 */
function extractVapiTransfers(data: VapiCallResponse): CallTransfer[] | undefined {
  const transfers: CallTransfer[] = [];
  const messages = data.artifact?.messages;
  const endedReason = data.endedReason;

  if (messages) {
    const resultMap = new Map<string, { result?: string; secondsFromStart?: number }>();
    for (const msg of messages) {
      if (msg.role === "tool_call_result" && msg.toolCallId) {
        resultMap.set(msg.toolCallId, { result: msg.result, secondsFromStart: msg.secondsFromStart });
      }
    }

    for (const msg of messages) {
      if ((msg.role !== "tool_calls" && msg.role !== "tool-call") || !msg.toolCalls) continue;
      for (const tc of msg.toolCalls) {
        if (!isVapiTransferToolCall(tc)) continue;
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch {}
        const destination = extractVapiTransferDestination(args);
        const resultEntry = tc.id ? resultMap.get(tc.id) : undefined;
        const status = resolveVapiToolTransferStatus(resultEntry, endedReason);
        const timestampMs = msg.secondsFromStart != null ? msg.secondsFromStart * 1000 : undefined;
        transfers.push({
          type: normalizeVapiTransferType(tc),
          destination,
          status,
          sources: ["platform_metadata"],
          ...(timestampMs != null ? { timestamp_ms: timestampMs } : {}),
        });
      }
    }
  }

  if (transfers.length === 0 && endedReason === "assistant-forwarded-call") {
    transfers.push({
      type: "assistant-forwarded-call",
      status: "completed",
      sources: ["platform_metadata"],
    });
  }

  return transfers.length > 0 ? transfers : undefined;
}

function isVapiTransferToolCall(toolCall: VapiToolCall): boolean {
  const name = toolCall.function.name.toLowerCase();
  const toolType = typeof toolCall.type === "string" ? toolCall.type.toLowerCase() : undefined;
  const functionType = typeof toolCall.function.type === "string" ? toolCall.function.type.toLowerCase() : undefined;
  return name === "transfercall"
    || name === "transfer_call"
    || name === "handoff"
    || toolType === "handoff"
    || functionType === "handoff";
}

function normalizeVapiTransferType(toolCall: VapiToolCall): string {
  const name = toolCall.function.name.toLowerCase();
  const toolType = typeof toolCall.type === "string" ? toolCall.type.toLowerCase() : undefined;
  const functionType = typeof toolCall.function.type === "string" ? toolCall.function.type.toLowerCase() : undefined;
  if (name === "handoff" || toolType === "handoff" || functionType === "handoff") {
    return "handoff";
  }
  return "transferCall";
}

function extractVapiTransferDestination(args: Record<string, unknown>): string | undefined {
  const destination = args.destination;
  if (typeof destination === "string") return destination;
  if (destination && typeof destination === "object") {
    const value = destination as Record<string, unknown>;
    if (typeof value.number === "string") return value.number;
    if (typeof value.sipUri === "string") return value.sipUri;
    if (typeof value.assistantName === "string") return value.assistantName;
    if (typeof value.assistantId === "string") return value.assistantId;
    if (typeof value.squadName === "string") return value.squadName;
    if (typeof value.squadId === "string") return value.squadId;
  }
  if (typeof args.number === "string") return args.number;
  if (typeof args.sipUri === "string") return args.sipUri;
  if (typeof args.assistantName === "string") return args.assistantName;
  if (typeof args.assistantId === "string") return args.assistantId;
  if (typeof args.squadName === "string") return args.squadName;
  if (typeof args.squadId === "string") return args.squadId;
  return undefined;
}

function resolveVapiToolTransferStatus(
  resultEntry: { result?: string } | undefined,
  endedReason: string | undefined,
): CallTransfer["status"] {
  if (endedReason === "assistant-forwarded-call") return "completed";
  if (!resultEntry) return "attempted";
  if (resultEntry.result) {
    try {
      const parsed = JSON.parse(resultEntry.result) as Record<string, unknown>;
      if (parsed.success === true) return "completed";
      if (parsed.success === false) return "failed";
    } catch {}
  }
  return "attempted";
}



function getRecordingUrl(recording: unknown): string | undefined {
  if (!recording) return undefined;
  if (typeof recording === "string") return recording;
  if (typeof recording !== "object") return undefined;

  const rec = recording as Record<string, unknown>;

  const direct = rec.url;
  if (typeof direct === "string") return direct;

  for (const value of Object.values(rec)) {
    if (typeof value === "string" && /^https?:\/\//.test(value)) {
      return value;
    }
    if (value && typeof value === "object") {
      const nested = (value as Record<string, unknown>).url;
      if (typeof nested === "string") return nested;
    }
  }

  return undefined;
}

function buildVapiUsage(
  costBreakdown: VapiCallResponse["costBreakdown"] | undefined,
  assistant: VapiCallResponse["assistant"] | undefined,
): UsageEntry[] | undefined {
  if (!costBreakdown) return undefined;
  const { llmPromptTokens, llmCompletionTokens, llmCachedPromptTokens } = costBreakdown;
  if (llmPromptTokens == null && llmCompletionTokens == null) return undefined;
  const entry: UsageEntry = {
    type: "llm",
    provider: assistant?.model?.provider ?? "unknown",
    model: assistant?.model?.model ?? "unknown",
    input_tokens: llmPromptTokens,
    output_tokens: llmCompletionTokens,
  };
  if (llmCachedPromptTokens != null && llmCachedPromptTokens > 0) {
    (entry as unknown as Record<string, unknown>).cached_input_tokens = llmCachedPromptTokens;
  }
  return [entry];
}

function buildVapiCostBreakdown(costBreakdown: VapiCallResponse["costBreakdown"] | undefined): CallMetadata["cost_breakdown"] {
  if (!costBreakdown) return undefined;
  return {
    stt_usd: costBreakdown.stt,
    llm_usd: costBreakdown.llm,
    tts_usd: costBreakdown.tts,
    transport_usd: costBreakdown.transport,
    platform_usd: costBreakdown.vapi,
    total_usd: costBreakdown.total,
    llm_prompt_tokens: costBreakdown.llmPromptTokens,
    llm_completion_tokens: costBreakdown.llmCompletionTokens,
  };
}

function getPrimaryRecordingUrl(artifact: VapiCallResponse["artifact"] | undefined): string | undefined {
  if (!artifact) return undefined;
  return artifact.recordingUrl
    ?? getRecordingUrl(artifact.recording)
    ?? artifact.stereoRecordingUrl
    ?? artifact.videoRecordingUrl;
}

function buildVapiRecordingVariants(artifact: VapiCallResponse["artifact"] | undefined): CallMetadata["recording_variants"] {
  if (!artifact) return undefined;
  return compactStringRecord({
    primary: artifact.recordingUrl,
    mono: getRecordingUrl(artifact.recording),
    stereo: artifact.stereoRecordingUrl,
    video: artifact.videoRecordingUrl,
  });
}

function buildVapiDebugUrls(
  data: Pick<VapiCallResponse, "artifact" | "monitor">,
): CallMetadata["provider_debug_urls"] {
  return compactStringRecord({
    listen: data.monitor?.listenUrl,
    control: data.monitor?.controlUrl,
    log: data.artifact?.logUrl,
    pcap: data.artifact?.pcapUrl,
  });
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
