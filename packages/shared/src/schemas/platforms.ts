/**
 * Platform credentials and settings: `connection.platform` in a suite.
 *
 * Written by: the user (suite file), completed by the CLI from the user's env.
 * Read by: the API (validated on submit, then encrypted), the worker and the
 * adapters (decrypted per call).
 */

import { z } from "zod";

/** The hosted voice platforms Vent calls. "websocket" (a custom agent) is the only other adapter. */
export const PLATFORM_PROVIDERS = ["vapi", "retell", "elevenlabs", "livekit", "bland"] as const;
export type PlatformProvider = (typeof PLATFORM_PROVIDERS)[number];

export function isPlatformProvider(adapter: string): adapter is PlatformProvider {
  return (PLATFORM_PROVIDERS as readonly string[]).includes(adapter);
}

const BasePlatformSchema = z.object({
  /** Max concurrent calls (platform-dependent) */
  max_concurrency: z.number().int().min(1).optional(),
});

const BlandPlatformSchema = BasePlatformSchema.extend({
  provider: z.literal("bland"),
  /** Bland API key (the CLI reads BLAND_API_KEY from the user's env) */
  bland_api_key: z.string().optional(),
  /** Bland pathway ID (the CLI reads BLAND_PATHWAY_ID from the user's env) */
  bland_pathway_id: z.string().optional(),
  /** Bland persona ID — reusable agent preset (the CLI reads BLAND_PERSONA_ID from the user's env) */
  persona_id: z.string().optional(),
  /** Task prompt — used instead of pathway_id for simple agents */
  task: z.string().optional(),
  /** Tool definitions (inline objects) or tool IDs (TL-xxx strings) */
  tools: z.array(z.unknown()).optional(),
  /** Voice name ("maya", "josh") or custom voice clone UUID */
  voice: z.string().optional(),
  /** Model: "base" (full features), "turbo" (fastest, limited features) */
  model: z.string().optional(),
  /** Opening sentence — overrides any greeting in the task/pathway */
  first_sentence: z.string().optional(),
  /** If true, agent waits for callee to speak first (default: false) */
  wait_for_greeting: z.boolean().optional(),
  /** Max call duration in minutes (default: 30) */
  max_duration: z.number().optional(),
  /** Temperature 0-1 (default: 0.7) */
  temperature: z.number().min(0).max(1).optional(),
  /** Language code e.g. "babel-en", "babel-es" */
  language: z.string().optional(),
  /** How quickly agent stops speaking when interrupted, in ms (default: 500) */
  interruption_threshold: z.number().optional(),
  /** When true, agent ignores user interruptions entirely */
  block_interruptions: z.boolean().optional(),
  /** When true, enable Bland's noise filtering on caller audio */
  noise_cancellation: z.boolean().optional(),
  /** Background audio: "office", "cafe", "restaurant", "none", or null (default phone static) */
  background_track: z.string().nullable().optional(),
  /** Boost transcription accuracy for specific words. Supports "word:boost_factor" */
  keywords: z.array(z.string()).optional(),
  /** Key-value pairs accessible as {{variable}} in agent prompts/pathways */
  request_data: z.record(z.unknown()).optional(),
  /** Pronunciation overrides */
  pronunciation_guide: z.array(z.object({
    word: z.string(),
    pronunciation: z.string(),
    case_sensitive: z.boolean().optional(),
    spaced: z.boolean().optional(),
  })).optional(),
  /** Start pathway from a specific node instead of the default */
  start_node_id: z.string().optional(),
  /** Specific pathway version to test (default: production) */
  pathway_version: z.number().optional(),
});

const LiveKitPlatformSchema = BasePlatformSchema.extend({
  provider: z.literal("livekit"),
  /** LiveKit API key (the CLI reads LIVEKIT_API_KEY from the user's env) */
  livekit_api_key: z.string().optional(),
  /** LiveKit API secret (the CLI reads LIVEKIT_API_SECRET from the user's env) */
  livekit_api_secret: z.string().optional(),
  /** LiveKit server URL, e.g. wss://your-app.livekit.cloud (the CLI reads LIVEKIT_URL from the user's env) */
  livekit_url: z.string().optional(),
  /** Explicit agent dispatch — agent_name from WorkerOptions. Omit for automatic dispatch. */
  livekit_agent_name: z.string().optional(),
}).strict();

const VapiPlatformSchema = BasePlatformSchema.extend({
  provider: z.literal("vapi"),
  /** Vapi API key (the CLI reads VAPI_API_KEY from the user's env) */
  vapi_api_key: z.string().optional(),
  /** Vapi assistant ID (the CLI reads VAPI_ASSISTANT_ID or VAPI_AGENT_ID from the user's env) */
  vapi_assistant_id: z.string().optional(),
});

const RetellPlatformSchema = BasePlatformSchema.extend({
  provider: z.literal("retell"),
  /** Retell API key (the CLI reads RETELL_API_KEY from the user's env) */
  retell_api_key: z.string().optional(),
  /** Retell agent ID (the CLI reads RETELL_AGENT_ID from the user's env) */
  retell_agent_id: z.string().optional(),
});

const ElevenLabsPlatformSchema = BasePlatformSchema.extend({
  provider: z.literal("elevenlabs"),
  /** ElevenLabs API key (the CLI reads ELEVENLABS_API_KEY from the user's env) */
  elevenlabs_api_key: z.string().optional(),
  /** ElevenLabs agent ID (the CLI reads ELEVENLABS_AGENT_ID from the user's env) */
  elevenlabs_agent_id: z.string().optional(),
});

export const PlatformConfigSchema = z.discriminatedUnion("provider", [
  BlandPlatformSchema,
  LiveKitPlatformSchema,
  VapiPlatformSchema,
  RetellPlatformSchema,
  ElevenLabsPlatformSchema,
]);

type PlatformConfig = z.infer<typeof PlatformConfigSchema>;
type PlatformField<P extends PlatformProvider> = Exclude<keyof Extract<PlatformConfig, { provider: P }>, "provider">;

// PLATFORM_PROVIDERS must list exactly the providers above; this fails to
// compile if one is added to either place but not the other.
const providersMatch: [PlatformProvider] extends [PlatformConfig["provider"]]
  ? [PlatformConfig["provider"]] extends [PlatformProvider] ? true : never
  : never = true;
void providersMatch;

// Fields a platform config needs before a call can be placed. Each inner list
// is one requirement that any of its fields satisfies.
const REQUIRED_PLATFORM_FIELDS: { [P in PlatformProvider]: PlatformField<P>[][] } = {
  vapi: [["vapi_api_key"], ["vapi_assistant_id"]],
  retell: [["retell_api_key"], ["retell_agent_id"]],
  elevenlabs: [["elevenlabs_api_key"], ["elevenlabs_agent_id"]],
  livekit: [["livekit_api_key"], ["livekit_api_secret"], ["livekit_url"]],
  // Each test call creates a Bland web agent, which has no persona field: the
  // instructions must come from a pathway or a task prompt, so a persona_id
  // alone gives the agent no instructions.
  bland: [["bland_api_key"], ["bland_pathway_id", "task"]],
};

/** The requirements `platform` leaves unmet. Each entry lists the config
 *  fields, any one of which would satisfy it. Empty when the config is complete. */
export function missingPlatformFields(platform: PlatformConfig): string[][] {
  const values: Record<string, unknown> = platform;
  const requirements: string[][] = REQUIRED_PLATFORM_FIELDS[platform.provider];
  return requirements.filter((anyOf) => anyOf.every((field) => !values[field]));
}
