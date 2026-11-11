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
 * 5. Post-call: GET /v1/calls/{call_id} (transcript, metadata), for pathways
 *    GET /v1/pathway_calls/{call_id}?v=2 (tool calls, transcript), and
 *    GET /v1/event_stream/{call_id} (LLM/TTS latency).
 * 6. Cleanup: DELETE /v1/agents/{id}.
 *
 * No webhook: everything Bland would push during the call is available from
 * the post-call endpoints, so the worker needs no public inbound URL.
 */

import type { BlandPlatformConfig, ObservedToolCall, CallMetadata, ComponentLatency } from "@vent/shared";
import type { ComfortNoiseMode, PlatformUtterance } from "../shared/audio-channel.js";
import { WebSocketAudioChannel } from "../shared/websocket-channel.js";
import {
  BLAND_API_BASE,
  type BlandCallResponse,
  parseBlandToolCalls,
  fetchBlandCallResponse,
  fetchBlandPathwayEvents,
  type BlandPathwayEvent,
  fetchBlandEventStream,
  findBlandCallIdByAgent,
  isBlandCallDone,
  buildBlandCallMetadata,
  buildBlandTranscripts,
} from "./bland-call-data.js";
import { pollUntilReady, callDataUnavailableWarning } from "../shared/post-call.js";

const BLAND_WS_BASE = "wss://stream-v2.aws.dc8.bland.ai";

export class BlandWsAudioChannel extends WebSocketAudioChannel {
  protected readonly label = "Bland";
  protected override outputSampleRate = 44100;
  // Bland may renegotiate the agent's playback rate in a JSON text frame.
  protected override agentSampleRate = 44100;
  // Zeros, not noise: Bland's server-side VAD hears any non-zero audio as the
  // caller talking and barges in, cutting the agent off mid-sentence. Its
  // browser SDK sends near-zero audio thanks to noise suppression.
  protected override comfortNoise: ComfortNoiseMode = "silence";

  // Bland's WS has no agent speech-state events (no speech_start/speech_stop on
  // the wire), so Vent's own voice detection decides when the agent's turn ends.
  hasPlatformEndOfTurn = false;

  private config: BlandPlatformConfig;
  private apiKey: string;
  private webAgentId: string | null = null;
  /** Kept after the agent is deleted, to find the call_id post-call. */
  private createdAgentId: string | null = null;
  private callId: string | null = null;

  private cachedCallResponse: BlandCallResponse | null = null;
  private pathwayEvents: BlandPathwayEvent[] = [];
  private componentLatencies: ComponentLatency[] = [];

  /** `config` has passed validateResolvedPlatformConfig, so it has an API key. */
  constructor(config: BlandPlatformConfig) {
    super();
    this.config = config;
    this.apiKey = config.bland_api_key!;
  }

  async connect(): Promise<void> {
    const connectStart = Date.now();

    // 1. Create ephemeral web agent
    const agentBody = this.buildAgentBody();
    console.log(`[bland-ws] POST /v1/agents → pathway_id: ${agentBody.pathway_id ?? "none"}`);

    const agentRes = await fetch(`${BLAND_API_BASE}/v1/agents`, {
      method: "POST",
      headers: {
        authorization: this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(agentBody),
    });

    if (!agentRes.ok) {
      const errorText = await agentRes.text();
      throw new Error(`Bland POST /v1/agents failed (${agentRes.status}): ${errorText}`);
    }

    const agentData = (await agentRes.json()) as { agent?: { agent_id?: string } };
    this.webAgentId = agentData.agent?.agent_id ?? null;
    if (!this.webAgentId) {
      throw new Error(`Bland POST /v1/agents response missing agent_id: ${JSON.stringify(agentData)}`);
    }
    this.createdAgentId = this.webAgentId;
    console.log(`[bland-ws] Created web agent: ${this.webAgentId}`);

    // 3. Authorize session
    const authRes = await fetch(`${BLAND_API_BASE}/v1/agents/${this.webAgentId}/authorize`, {
      method: "POST",
      headers: {
        authorization: this.apiKey,
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
    const wsUrl = `${BLAND_WS_BASE}/ws/connect/blandshared?agent=${this.webAgentId}&token=${token}&sampleRate=${this.agentSampleRate}`;
    console.log(`[bland-ws] Connecting WebSocket...`);

    await this.openSocket(wsUrl, { perMessageDeflate: false }, (text) => this.handleTextFrame(text));
    this._stats.connectLatencyMs = Date.now() - connectStart;
    console.log(`[bland-ws] Connected, took ${this._stats.connectLatencyMs}ms`);

    // Start comfort noise
    this.startComfortNoise();
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
    return data ? parseBlandToolCalls(data, this.pathwayEvents) : [];
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

  getTranscripts(): PlatformUtterance[] {
    return buildBlandTranscripts(this.cachedCallResponse, this.pathwayEvents);
  }

  // ── Private: WebSocket events ─────────────────────────────

  private handleTextFrame(raw: string): void {
    try {
      const msg = JSON.parse(raw) as Record<string, unknown>;

      // Bland sends `{ type: "callID", payload }` once, then `{ event: "update", payload }` frames.
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
    const p = this.config;
    const body: Record<string, unknown> = {
      record: true,
      wait_for_greeting: p.wait_for_greeting ?? false,
    };

    if (p.bland_pathway_id) body.pathway_id = p.bland_pathway_id;
    // Web agents take the instructions as `prompt` (POST /v1/agents); `task` is the phone-call field.
    if (p.task) body.prompt = p.task;
    if (p.persona_id) body.persona_id = p.persona_id;
    if (p.voice) body.voice = p.voice;
    if (p.model) body.model = p.model;
    if (p.first_sentence) body.first_sentence = p.first_sentence;
    if (p.max_duration != null) body.max_duration = p.max_duration;
    if (p.temperature != null) body.temperature = p.temperature;
    if (p.language) body.language = p.language;
    if (p.interruption_threshold != null) body.interruption_threshold = p.interruption_threshold;
    if (p.block_interruptions != null) body.block_interruptions = p.block_interruptions;
    if (p.noise_cancellation != null) body.noise_cancellation = p.noise_cancellation;
    if (p.tools?.length) body.tools = p.tools;
    if (p.background_track !== undefined) body.background_track = p.background_track;
    if (p.keywords?.length) body.keywords = p.keywords;
    if (p.request_data) body.request_data = p.request_data;
    if (p.pronunciation_guide?.length) body.pronunciation_guide = p.pronunciation_guide;
    if (p.start_node_id) body.start_node_id = p.start_node_id;
    if (p.pathway_version != null) body.pathway_version = p.pathway_version;

    return body;
  }

  private callData?: Promise<BlandCallResponse | null>;

  /** One shared fetch per call: every caller waits on the same poll. */
  private fetchCallResponseCached(): Promise<BlandCallResponse | null> {
    this.callData ??= this.loadCallData();
    return this.callData;
  }

  private async loadCallData(): Promise<BlandCallResponse | null> {
    const apiKey = this.apiKey;
    const agentId = this.createdAgentId;
    if (!this.callId && agentId) {
      this.callId = await pollUntilReady("bland-call-id", () => findBlandCallIdByAgent(apiKey, agentId), () => true);
    }
    const callId = this.callId;
    if (!callId) return null;

    const data = await pollUntilReady("bland-postcall", () => fetchBlandCallResponse(apiKey, callId), isBlandCallDone);
    if (!data) return null;

    this.cachedCallResponse = data;
    if (data.pathway_id) this.pathwayEvents = await fetchBlandPathwayEvents(apiKey, callId);
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
        headers: { authorization: this.apiKey },
      });
      console.log(`[bland-ws] Deleted web agent: ${agentId}`);
    } catch {
      // Cleanup error — ignore
    }
  }
}
