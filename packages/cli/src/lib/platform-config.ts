import { PlatformConfigSchema, type PlatformConfig } from "@vent/shared";

const PLATFORM_ENV_MAP = {
  vapi: { vapi_api_key: "VAPI_API_KEY", vapi_assistant_id: "VAPI_ASSISTANT_ID" },
  bland: { bland_api_key: "BLAND_API_KEY", bland_pathway_id: "BLAND_PATHWAY_ID", persona_id: "BLAND_PERSONA_ID" },
  livekit: { livekit_api_key: "LIVEKIT_API_KEY", livekit_api_secret: "LIVEKIT_API_SECRET", livekit_url: "LIVEKIT_URL" },
  retell: { retell_api_key: "RETELL_API_KEY", retell_agent_id: "RETELL_AGENT_ID" },
  elevenlabs: { elevenlabs_api_key: "ELEVENLABS_API_KEY", elevenlabs_agent_id: "ELEVENLABS_AGENT_ID" },
} as const;

type RemotePlatformAdapter = keyof typeof PLATFORM_ENV_MAP;

function isRemotePlatformAdapter(adapter: string | undefined): adapter is RemotePlatformAdapter {
  return !!adapter && adapter in PLATFORM_ENV_MAP;
}

function looksLikeEnvReference(value: unknown): boolean {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]+$/.test(value);
}

function isMissingResolvedValue(value: unknown): boolean {
  return !value || looksLikeEnvReference(value);
}

function requireField(platform: PlatformConfig): void {
  switch (platform.provider) {
    case "vapi":
      if (isMissingResolvedValue(platform.vapi_api_key)) {
        throw new Error("Missing VAPI_API_KEY in .env");
      }
      if (isMissingResolvedValue(platform.vapi_assistant_id)) {
        throw new Error("Missing VAPI_ASSISTANT_ID or VAPI_AGENT_ID in .env");
      }
      return;
    case "retell":
      if (isMissingResolvedValue(platform.retell_api_key)) {
        throw new Error("Missing RETELL_API_KEY in .env");
      }
      if (isMissingResolvedValue(platform.retell_agent_id)) {
        throw new Error("Missing RETELL_AGENT_ID in .env");
      }
      return;
    case "elevenlabs":
      if (isMissingResolvedValue(platform.elevenlabs_api_key)) {
        throw new Error("Missing ELEVENLABS_API_KEY in .env");
      }
      if (isMissingResolvedValue(platform.elevenlabs_agent_id)) {
        throw new Error("Missing ELEVENLABS_AGENT_ID in .env");
      }
      return;
    case "livekit":
      if (isMissingResolvedValue(platform.livekit_api_key)) {
        throw new Error("Missing LIVEKIT_API_KEY in .env");
      }
      if (isMissingResolvedValue(platform.livekit_api_secret)) {
        throw new Error("Missing LIVEKIT_API_SECRET in .env");
      }
      if (isMissingResolvedValue(platform.livekit_url)) {
        throw new Error("Missing LIVEKIT_URL in .env");
      }
      return;
    case "bland":
      if (isMissingResolvedValue(platform.bland_api_key)) {
        throw new Error("Missing BLAND_API_KEY in .env");
      }
      if (isMissingResolvedValue(platform.bland_pathway_id) && isMissingResolvedValue(platform.task) && isMissingResolvedValue(platform.persona_id)) {
        throw new Error("Missing BLAND_PATHWAY_ID, BLAND_PERSONA_ID, or platform.task in .env");
      }
      return;
  }
}

export function resolveRemotePlatformConfig(config: unknown): PlatformConfig | null {
  const cfg = config as {
    connection?: {
      adapter?: string;
      platform?: Record<string, unknown> & { provider?: string };
      platform_connection_id?: string;
    };
  };
  const adapter = cfg.connection?.adapter;
  if (!isRemotePlatformAdapter(adapter)) return null;
  if (cfg.connection?.platform_connection_id) return null;

  const current = cfg.connection?.platform ?? {};
  const provider = current.provider ?? adapter;
  if (provider !== adapter) {
    throw new Error(`connection.platform.provider (${provider}) must match connection.adapter (${adapter})`);
  }

  const resolved: Record<string, unknown> = {
    ...current,
    provider,
  };

  const envFields = PLATFORM_ENV_MAP[adapter];
  for (const [field, envVar] of Object.entries(envFields)) {
    const currentValue = resolved[field];
    const needsResolve = !currentValue || currentValue === envVar || looksLikeEnvReference(currentValue);
    if (needsResolve) {
      const envValue = process.env[envVar];
      if (envValue) {
        resolved[field] = envValue;
      }
    }
  }

  // Accept VAPI_AGENT_ID as alias for VAPI_ASSISTANT_ID
  if (adapter === "vapi" && !resolved.vapi_assistant_id) {
    const alt = process.env["VAPI_AGENT_ID"];
    if (alt) resolved.vapi_assistant_id = alt;
  }

  const platform = PlatformConfigSchema.parse(resolved);
  requireField(platform);
  return platform;
}
