import { PlatformConfigSchema, missingPlatformFields, type PlatformConfig } from "@vent/shared";

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

/** Names a required config key the way the user sets it: its env var, or `platform.<key>` for inline-only fields. */
function describeField(adapter: RemotePlatformAdapter, field: string): string {
  if (adapter === "vapi" && field === "vapi_assistant_id") return "VAPI_ASSISTANT_ID or VAPI_AGENT_ID";
  const envFields: Record<string, string> = PLATFORM_ENV_MAP[adapter];
  return envFields[field] ?? `platform.${field}`;
}

function requireFields(adapter: RemotePlatformAdapter, platform: PlatformConfig): void {
  const missing = missingPlatformFields(platform);
  if (missing.length === 0) return;
  const list = missing.map((anyOf) => anyOf.map((field) => describeField(adapter, field)).join(" or ")).join(", ");
  throw new Error(`Missing ${list} (set it in .env, .env.local or the environment)`);
}

export function resolveRemotePlatformConfig(config: unknown): PlatformConfig | null {
  const cfg = config as {
    connection?: {
      adapter?: string;
      platform?: Record<string, unknown> & { provider?: string };
    };
  };
  const adapter = cfg.connection?.adapter;
  if (!isRemotePlatformAdapter(adapter)) return null;

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
    if (!currentValue || looksLikeEnvReference(currentValue)) {
      // An unresolved env reference counts as missing.
      resolved[field] = process.env[envVar] || undefined;
    }
  }

  // Accept VAPI_AGENT_ID as alias for VAPI_ASSISTANT_ID
  if (adapter === "vapi" && !resolved.vapi_assistant_id) {
    const alt = process.env["VAPI_AGENT_ID"];
    if (alt) resolved.vapi_assistant_id = alt;
  }

  const platform = PlatformConfigSchema.parse(resolved);
  requireFields(adapter, platform);
  return platform;
}
