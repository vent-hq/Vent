import type {
  AdapterType,
  PlatformConfig,
  BlandPlatformConfig,
  LiveKitPlatformConfig,
  VapiPlatformConfig,
  RetellPlatformConfig,
  ElevenLabsPlatformConfig,
} from "@vent/shared";
import { RUNNER_CALLBACK_HEADER } from "@vent/shared";
import type { AudioChannel } from "./audio-channel.js";

export type { AudioChannel } from "./audio-channel.js";

export interface AudioChannelConfig {
  adapter: AdapterType;
  agentUrl?: string;
  platform?: PlatformConfig;
  relayHeaders?: Record<string, string>;
  runId?: string;
  callName?: string;
  /** Target sample rate for WebSocket wire format. Default: 24000. */
  wsSampleRate?: number;
}

// Each call runs in its own process, so load only the chosen platform's
// adapter: the platform SDKs together add ~150 MB to every call process.
export async function createAudioChannel(config: AudioChannelConfig): Promise<AudioChannel> {
  const agentUrl = config.agentUrl ?? "http://localhost:3001";

  switch (config.adapter) {
    case "websocket": {
      let wsUrl = agentUrl.replace(/^http/, "ws");
      // When connecting through relay, append a unique conn_id per call connection
      if (wsUrl.includes("/relay/connect")) {
        const connId = crypto.randomUUID();
        wsUrl += (wsUrl.includes("?") ? "&" : "?") + `conn_id=${connId}`;
      }
      // Pass runner auth header + Fly routing header for relay connections
      const headers: Record<string, string> = {};
      if (wsUrl.includes("/relay/connect")) {
        const secret = process.env["RUNNER_CALLBACK_SECRET"] ?? "";
        if (secret) headers[RUNNER_CALLBACK_HEADER] = secret;
        if (config.relayHeaders) Object.assign(headers, config.relayHeaders);
      }
      const { WsAudioChannel } = await import("./ws-audio-channel.js");
      return new WsAudioChannel({
        wsUrl,
        headers,
        sampleRate: config.wsSampleRate,
      });
    }

    case "livekit": {
      const p = config.platform as LiveKitPlatformConfig | undefined;
      const apiKey = p?.livekit_api_key || process.env["LIVEKIT_API_KEY"] || "";
      const apiSecret = p?.livekit_api_secret || process.env["LIVEKIT_API_SECRET"] || "";
      const livekitUrl = p?.livekit_url || process.env["LIVEKIT_URL"] || "";
      const agentName = p?.livekit_agent_name;

      if (!livekitUrl) throw new Error("LiveKit adapter requires LIVEKIT_URL env or platform.livekit_url");
      if (!apiKey) throw new Error("LiveKit adapter requires LIVEKIT_API_KEY env or platform.livekit_api_key");
      if (!apiSecret) throw new Error("LiveKit adapter requires LIVEKIT_API_SECRET env or platform.livekit_api_secret");

      const roomName = `vent-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
      const { WebRtcAudioChannel } = await import("./webrtc-audio-channel.js");
      return new WebRtcAudioChannel({
        livekitUrl,
        apiKey,
        apiSecret,
        roomName,
        agentName,
      });
    }

    case "vapi": {
      const p = config.platform as VapiPlatformConfig | undefined;
      const apiKey = p?.vapi_api_key || process.env["VAPI_API_KEY"] || "";
      const assistantId = p?.vapi_assistant_id || process.env["VAPI_ASSISTANT_ID"] || process.env["VAPI_AGENT_ID"] || "";
      if (!apiKey) throw new Error("Vapi adapter requires vapi_api_key or VAPI_API_KEY env");
      if (!assistantId) throw new Error("Vapi adapter requires VAPI_ASSISTANT_ID or VAPI_AGENT_ID in .env");
      const { VapiAudioChannel } = await import("./vapi-audio-channel.js");
      return new VapiAudioChannel({ apiKey, assistantId });
    }

    case "retell": {
      const p = config.platform as RetellPlatformConfig | undefined;
      const apiKey = p?.retell_api_key || process.env["RETELL_API_KEY"] || "";
      const agentId = p?.retell_agent_id || process.env["RETELL_AGENT_ID"] || "";
      if (!apiKey) throw new Error("Retell adapter requires retell_api_key or RETELL_API_KEY env");
      if (!agentId) throw new Error("Retell adapter requires retell_agent_id or RETELL_AGENT_ID env");
      const { RetellAudioChannel } = await import("./retell-audio-channel.js");
      return new RetellAudioChannel({ apiKey, agentId });
    }

    case "elevenlabs": {
      const p = config.platform as ElevenLabsPlatformConfig | undefined;
      const apiKey = p?.elevenlabs_api_key || process.env["ELEVENLABS_API_KEY"] || "";
      const agentId = p?.elevenlabs_agent_id || process.env["ELEVENLABS_AGENT_ID"] || "";
      if (!apiKey) throw new Error("ElevenLabs adapter requires elevenlabs_api_key or ELEVENLABS_API_KEY env");
      if (!agentId) throw new Error("ElevenLabs adapter requires elevenlabs_agent_id or ELEVENLABS_AGENT_ID env");
      const { ElevenLabsAudioChannel } = await import("./elevenlabs-audio-channel.js");
      return new ElevenLabsAudioChannel({ apiKey, agentId });
    }

    case "bland": {
      const p = config.platform as BlandPlatformConfig | undefined;
      const apiKey = p?.bland_api_key || process.env["BLAND_API_KEY"] || "";
      const pathwayId = p?.bland_pathway_id || process.env["BLAND_PATHWAY_ID"] || "";
      if (!apiKey) throw new Error("Bland adapter requires bland_api_key or BLAND_API_KEY env");
      if (!pathwayId && !p?.task) {
        throw new Error("Bland adapter requires bland_pathway_id or platform.task");
      }

      const { BlandWsAudioChannel } = await import("./bland-ws-audio-channel.js");
      return new BlandWsAudioChannel({
        apiKey,
        agentId: pathwayId || undefined,
        callOptions: {
          task: p?.task,
          tools: p?.tools,
          voice: p?.voice,
          model: p?.model,
          first_sentence: p?.first_sentence,
          wait_for_greeting: p?.wait_for_greeting,
          max_duration: p?.max_duration,
          temperature: p?.temperature,
          language: p?.language,
          interruption_threshold: p?.interruption_threshold,
          block_interruptions: p?.block_interruptions,
          noise_cancellation: p?.noise_cancellation,
          background_track: p?.background_track,
          keywords: p?.keywords,
          request_data: p?.request_data,
          pronunciation_guide: p?.pronunciation_guide,
          start_node_id: p?.start_node_id,
          pathway_version: p?.pathway_version,
          persona_id: p?.persona_id,
        },
      });
    }

    default:
      throw new Error(`Unknown adapter type: ${config.adapter}`);
  }
}
