import type {
  AdapterType,
  PlatformConfig,
  BlandPlatformConfig,
  LiveKitPlatformConfig,
  VapiPlatformConfig,
  RetellPlatformConfig,
  ElevenLabsPlatformConfig,
} from "@vent/shared";
import type { AudioChannel } from "./shared/audio-channel.js";

export type { AudioChannel, PlatformUtterance } from "./shared/audio-channel.js";

export interface AudioChannelConfig {
  adapter: AdapterType;
  agentUrl?: string;
  /** Validated and decrypted by the worker; required for every platform adapter. */
  platform?: PlatformConfig;
  /** Relay auth + routing headers; set only for calls to a local agent through the relay. */
  relayHeaders?: Record<string, string>;
}

// Each call runs in its own process, so load only the chosen platform's
// adapter: the platform SDKs together add ~150 MB to every call process.
export async function createAudioChannel(config: AudioChannelConfig): Promise<AudioChannel> {
  switch (config.adapter) {
    case "websocket": {
      // The worker always passes the agent URL or the relay URL for websocket calls.
      if (!config.agentUrl) throw new Error("websocket adapter requires agentUrl");
      let wsUrl = config.agentUrl.replace(/^http/, "ws");
      // When connecting through relay, append a unique conn_id per call connection
      if (wsUrl.includes("/relay/connect")) {
        const connId = crypto.randomUUID();
        wsUrl += (wsUrl.includes("?") ? "&" : "?") + `conn_id=${connId}`;
      }
      const { WsAudioChannel } = await import("./platforms/websocket.js");
      return new WsAudioChannel({ wsUrl, headers: config.relayHeaders ?? {} });
    }

    // Platform credentials come only from the run's platform config, which
    // validateResolvedPlatformConfig (packages/platform-connections) has
    // already checked, so the required fields are present.

    case "livekit": {
      const p = config.platform as LiveKitPlatformConfig;
      const { WebRtcAudioChannel } = await import("./platforms/livekit.js");
      return new WebRtcAudioChannel({
        livekitUrl: p.livekit_url!,
        apiKey: p.livekit_api_key!,
        apiSecret: p.livekit_api_secret!,
        roomName: `vent-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`,
        agentName: p.livekit_agent_name,
      });
    }

    case "vapi": {
      const p = config.platform as VapiPlatformConfig;
      const { VapiAudioChannel } = await import("./platforms/vapi.js");
      return new VapiAudioChannel({ apiKey: p.vapi_api_key!, assistantId: p.vapi_assistant_id! });
    }

    case "retell": {
      const p = config.platform as RetellPlatformConfig;
      const { RetellAudioChannel } = await import("./platforms/retell.js");
      return new RetellAudioChannel({ apiKey: p.retell_api_key!, agentId: p.retell_agent_id! });
    }

    case "elevenlabs": {
      const p = config.platform as ElevenLabsPlatformConfig;
      const { ElevenLabsAudioChannel } = await import("./platforms/elevenlabs.js");
      return new ElevenLabsAudioChannel({ apiKey: p.elevenlabs_api_key!, agentId: p.elevenlabs_agent_id! });
    }

    case "bland": {
      const { BlandWsAudioChannel } = await import("./platforms/bland.js");
      return new BlandWsAudioChannel(config.platform as BlandPlatformConfig);
    }

    default:
      throw new Error(`Unknown adapter type: ${config.adapter}`);
  }
}
