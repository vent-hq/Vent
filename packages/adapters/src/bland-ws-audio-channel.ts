/**
 * Bland AI Audio Channel (WebSocket transport)
 *
 * Direct WebSocket connection to Bland's Web Agent API.
 * Binary PCM16 audio at 44.1kHz wire rate, resampled to 24kHz internally.
 *
 * Flow:
 * 1. POST /v1/agents — create ephemeral web agent with pathway/task
 * 2. POST /v1/agents/{id}/authorize — get single-use token
 * 3. Connect wss://stream-v2.aws.dc8.bland.ai/ws/connect/blandshared?agent={id}&token={token}&sampleRate=24000
 * 4. Binary frames = PCM16 bidirectional. Text frames = JSON events,
 *    including `callID` with the call_id.
 * 5. Post-call: GET /v1/calls/{call_id} (transcript, tool calls, metadata)
 *    and GET /v1/event_stream/{call_id} (LLM/TTS latency).
 * 6. Cleanup: DELETE /v1/agents/{id}.
 *
 * No webhook: everything Bland would push during the call is available from
 * the post-call endpoints, so the worker needs no public inbound URL.
 */

import WebSocket from "ws";
import { resample } from "@vent/voice";
import type { ObservedToolCall, CallMetadata, ComponentLatency } from "@vent/shared";
import { BaseAudioChannel, CONNECT_TIMEOUT_MS, type ComfortNoiseMode, type SendAudioOptions } from "./audio-channel.js";
import {
  BLAND_API_BASE,
  type BlandCallOptions,
  type BlandCallResponse,
  type BlandCorrectedTranscriptEntry,
  parseBlandToolCalls,
  extractBlandTransfers,
  fetchBlandCallResponse,
  fetchBlandCorrectedTranscripts,
  fetchBlandEventStream,
  findBlandCallIdByAgent,
  isBlandCallDone,
  buildBlandCallMetadata,
  buildBlandTranscripts,
} from "./bland-shared.js";
import { pollUntilReady, callDataUnavailableWarning } from "./post-call.js";

export interface BlandWsAudioChannelConfig {
  apiKey: string;
  /** pathway_id (UUID) or empty if using task mode */
  agentId?: string;
  /** Bland-specific call options */
  callOptions?: BlandCallOptions;
}



const BLAND_WS_BASE = "wss://stream-v2.aws.dc8.bland.ai";

export class BlandWsAudioChannel extends BaseAudioChannel {
  protected override outputSampleRate = 44100;
  protected override pacingIntervalMs = 10; // 2x real-time
  // Zeros, not noise: Bland's server-side VAD hears any non-zero audio as the
  // caller talking and barges in, cutting the agent off mid-sentence. Its
  // browser SDK sends near-zero audio thanks to noise suppression.
  protected override comfortNoise: ComfortNoiseMode = "silence";

  // Bland's WS has no agent speech-state events (no speech_start/speech_stop on
  // the wire), so Vent's own voice detection decides when the agent's turn ends.
  hasPlatformEndOfTurn = false;

  private config: BlandWsAudioChannelConfig;
  private ws: WebSocket | null = null;
  private webAgentId: string | null = null;
  /** Kept after the agent is deleted, to find the call_id post-call. */
  private createdAgentId: string | null = null;
  private callId: string | null = null;

  private cachedCallResponse: BlandCallResponse | null = null;
  private cachedCorrectedTranscripts: BlandCorrectedTranscriptEntry[] | null = null;
  private componentLatencies: ComponentLatency[] = [];

  // Playback sample rate (may be updated by server JSON message)
  private playbackSampleRate = 44100;

  constructor(config: BlandWsAudioChannelConfig) {
    super();
    this.config = config;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();
    this.enableRecordingCapture();

    // 1. Create ephemeral web agent
    const agentBody = this.buildAgentBody();
    console.log(`[bland-ws] POST /v1/agents → pathway_id: ${agentBody.pathway_id ?? "none"}`);

    const agentRes = await fetch(`${BLAND_API_BASE}/v1/agents`, {
      method: "POST",
      headers: {
        authorization: this.config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(agentBody),
    });

    if (!agentRes.ok) {
      const errorText = await agentRes.text();
      throw new Error(`Bland POST /v1/agents failed (${agentRes.status}): ${errorText}`);
    }

    const agentData = (await agentRes.json()) as { agent?: { agent_id?: string }; agent_id?: string };
    this.webAgentId = agentData.agent?.agent_id ?? agentData.agent_id ?? null;
    if (!this.webAgentId) {
      throw new Error(`Bland POST /v1/agents response missing agent_id: ${JSON.stringify(agentData)}`);
    }
    this.createdAgentId = this.webAgentId;
    console.log(`[bland-ws] Created web agent: ${this.webAgentId}`);

    // 3. Authorize session
    const authRes = await fetch(`${BLAND_API_BASE}/v1/agents/${this.webAgentId}/authorize`, {
      method: "POST",
      headers: {
        authorization: this.config.apiKey,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    if (!authRes.ok) {
      const errorText = await authRes.text();
      await this.deleteWebAgent();
      throw new Error(`Bland POST /v1/agents/${this.webAgentId}/authorize failed (${authRes.status}): ${errorText}`);
    }

    const authData = (await authRes.json()) as { token?: string };
    const token = authData.token;
    if (!token) {
      await this.deleteWebAgent();
      throw new Error(`Bland authorize response missing token: ${JSON.stringify(authData)}`);
    }

    // 4. Connect WebSocket
    const wsUrl = `${BLAND_WS_BASE}/ws/connect/blandshared?agent=${this.webAgentId}&token=${token}&sampleRate=${this.playbackSampleRate}`;
    console.log(`[bland-ws] Connecting WebSocket...`);

    await this.connectWebSocket(wsUrl);
    this._stats.connectLatencyMs = Date.now() - connectStart;
    console.log(`[bland-ws] Connected, took ${this._stats.connectLatencyMs}ms`);

    // Start comfort noise
    this.startComfortNoise();
  }

  protected async writeAudioFrame(samples: Int16Array, _sampleRate: number): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  }

  override sendAudio(pcm: Buffer, opts?: SendAudioOptions): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Bland WebSocket channel not connected");
    }
    super.sendAudio(pcm, opts);
  }

  async disconnect(): Promise<void> {
    this.stopComfortNoise();

    // Close WebSocket
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }

    // Cleanup: delete ephemeral web agent
    await this.deleteWebAgent();
  }

  // ── Post-call data ────────────────────────────────────────

  async getCallData(): Promise<ObservedToolCall[]> {
    const data = await this.fetchCallResponseCached();
    return data ? parseBlandToolCalls(data) : [];
  }

  async getCallMetadata(): Promise<CallMetadata | null> {
    const data = await this.fetchCallResponseCached();
    if (!data) {
      return {
        platform: "bland",
        provider_call_id: this.callId ?? undefined,
        provider_warnings: [callDataUnavailableWarning("Bland")],
      };
    }
    return buildBlandCallMetadata(data, this.callId);
  }

  getComponentTimings(): ComponentLatency[] {
    return this.componentLatencies;
  }

  getTranscripts(): Array<{ turnIndex: number; text: string }> {
    return buildBlandTranscripts(this.cachedCallResponse, this.cachedCorrectedTranscripts);
  }

  // ── Private: WebSocket connection ─────────────────────────

  private connectWebSocket(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ws.close();
          reject(new Error(`Bland WebSocket connect timeout (${CONNECT_TIMEOUT_MS}ms)`));
        }
      }, CONNECT_TIMEOUT_MS);

      ws.on("open", () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        this.ws = ws;
        this._connectTimestampMs = Date.now();
        this._connectMonotonicMs = performance.now();
        this.setupHandlers(ws);
        resolve();
      });

      ws.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(err);
        } else {
          this._stats.errorEvents.push(err.message);
          this.emit("error", err);
        }
      });

      ws.on("close", () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error("Bland WebSocket closed before open"));
        }
      });
    });
  }

  private setupHandlers(ws: WebSocket): void {
    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) {
        this.handleBinaryFrame(data);
      } else {
        this.handleTextFrame(data);
      }
    });

    ws.on("close", () => {
      this.stopComfortNoise();
      this.ws = null;
      this.emit("disconnected");
    });

    ws.on("error", (err) => {
      this._stats.errorEvents.push(err.message);
      this.emit("error", err);
    });
  }

  private handleBinaryFrame(data: Buffer | ArrayBuffer | Buffer[]): void {
    let raw: Buffer;
    if (Buffer.isBuffer(data)) {
      raw = data;
    } else if (data instanceof ArrayBuffer) {
      raw = Buffer.from(new Uint8Array(data));
    } else {
      raw = Buffer.concat(data as Buffer[]);
    }

    this._stats.bytesReceived += raw.length;

    // Resample if server negotiated a different playback rate
    let pcm24k: Buffer;
    if (this.playbackSampleRate !== 24000) {
      pcm24k = resample(raw, this.playbackSampleRate, 24000);
    } else {
      pcm24k = raw;
    }

    this.captureAgentAudio(pcm24k, performance.now() - this._connectMonotonicMs);
    this.emit("audio", pcm24k);
  }

  private handleTextFrame(data: Buffer | ArrayBuffer | Buffer[]): void {
    let raw: string;
    if (Buffer.isBuffer(data)) {
      raw = data.toString();
    } else if (data instanceof ArrayBuffer) {
      raw = Buffer.from(new Uint8Array(data)).toString();
    } else {
      raw = Buffer.concat(data as Buffer[]).toString();
    }

    try {
      const msg = JSON.parse(raw) as Record<string, unknown>;

      // Check for playback sample rate negotiation (Bland uses multiple field names)
      const negotiatedRate = (msg.playbackSampleRate ?? msg.sample_rate ?? msg.sampleRate ?? msg.pcm_sample_rate) as number | undefined;
      if (typeof negotiatedRate === "number" && negotiatedRate > 0 && negotiatedRate !== this.playbackSampleRate) {
        console.log(`[bland-ws] Server negotiated sampleRate: ${this.playbackSampleRate} → ${negotiatedRate}`);
        this.playbackSampleRate = negotiatedRate;
      }

      // Extract call_id from WebSocket (sent as callID event)
      const type = (msg.type ?? msg.event ?? "") as string;
      if (type === "callID" && typeof msg.payload === "string" && !this.callId) {
        this.callId = msg.payload;
        console.log(`[bland-ws] Got call_id from WebSocket: ${this.callId}`);
      }

      // Log all JSON messages for debugging
      console.log(`[bland-ws] Text event: ${type || "unknown"} ${JSON.stringify(msg).slice(0, 250)}`);
    } catch {
      // Not JSON — ignore
    }
  }

  // ── Helpers ───────────────────────────────────────────────

  private buildAgentBody(): Record<string, unknown> {
    const opts = this.config.callOptions;
    const body: Record<string, unknown> = {
      record: true,
      wait_for_greeting: opts?.wait_for_greeting ?? false,
    };

    if (this.config.agentId) body.pathway_id = this.config.agentId;
    // Web agents take the instructions as `prompt` (POST /v1/agents); `task` is the phone-call field.
    if (opts?.task) body.prompt = opts.task;
    if (opts?.persona_id) body.persona_id = opts.persona_id;
    if (opts?.voice) body.voice = opts.voice;
    if (opts?.model) body.model = opts.model;
    if (opts?.first_sentence) body.first_sentence = opts.first_sentence;
    if (opts?.max_duration != null) body.max_duration = opts.max_duration;
    if (opts?.temperature != null) body.temperature = opts.temperature;
    if (opts?.language) body.language = opts.language;
    if (opts?.interruption_threshold != null) body.interruption_threshold = opts.interruption_threshold;
    if (opts?.block_interruptions != null) body.block_interruptions = opts.block_interruptions;
    if (opts?.noise_cancellation != null) body.noise_cancellation = opts.noise_cancellation;
    if (opts?.tools?.length) body.tools = opts.tools;
    if (opts?.background_track !== undefined) body.background_track = opts.background_track;
    if (opts?.keywords?.length) body.keywords = opts.keywords;
    if (opts?.request_data) body.request_data = opts.request_data;
    if (opts?.pronunciation_guide?.length) body.pronunciation_guide = opts.pronunciation_guide;
    if (opts?.start_node_id) body.start_node_id = opts.start_node_id;
    if (opts?.pathway_version != null) body.pathway_version = opts.pathway_version;

    return body;
  }

  private callData?: Promise<BlandCallResponse | null>;

  /** One shared fetch per call: every caller waits on the same poll. */
  private fetchCallResponseCached(): Promise<BlandCallResponse | null> {
    this.callData ??= this.loadCallData();
    return this.callData;
  }

  private async loadCallData(): Promise<BlandCallResponse | null> {
    const apiKey = this.config.apiKey;
    const agentId = this.createdAgentId;
    if (!this.callId && agentId) {
      this.callId = await pollUntilReady("bland-call-id", () => findBlandCallIdByAgent(apiKey, agentId), () => true);
    }
    const callId = this.callId;
    if (!callId) return null;

    const data = await pollUntilReady("bland-postcall", () => fetchBlandCallResponse(apiKey, callId), isBlandCallDone);
    if (!data) return null;

    this.cachedCallResponse = data;
    this.cachedCorrectedTranscripts = await fetchBlandCorrectedTranscripts(apiKey, callId);
    this.componentLatencies = await fetchBlandEventStream(apiKey, callId);
    return data;
  }


  /** Delete the ephemeral web agent (cleanup, errors ignored). */
  private async deleteWebAgent(): Promise<void> {
    if (!this.webAgentId) return;
    const agentId = this.webAgentId;
    this.webAgentId = null;
    try {
      await fetch(`${BLAND_API_BASE}/v1/agents/${agentId}`, {
        method: "DELETE",
        headers: { authorization: this.config.apiKey },
      });
      console.log(`[bland-ws] Deleted web agent: ${agentId}`);
    } catch {
      // Cleanup error — ignore
    }
  }
}
