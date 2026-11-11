import type { z } from "zod";
import type {
  AccessCredentialsSchema,
  AdapterTypeSchema,
  AgentSessionResponseSchema,
  CallerAudioEffectsSchema,
  CallerPersonaSchema,
  CallMetadataSchema,
  CallTransferSchema,
  ComponentLatencySchema,
  ConversationCallResultSchema,
  ConversationCallSpecSchema,
  ConversationMetricsSchema,
  ConversationTurnSchema,
  PlatformTurnSchema,
  CallCostSchema,
  ObservedToolCallSchema,
  PlatformConfigSchema,
  ProviderWarningSchema,
  RunJobSchema,
  SignalQualityMetricsSchema,
} from "./schemas/index.js";

// Types are the parsed (output) shape of their schemas: defaults applied.

export type AccessCredentials = z.infer<typeof AccessCredentialsSchema>;
export type AdapterType = z.infer<typeof AdapterTypeSchema>;

export type CallerPersona = z.infer<typeof CallerPersonaSchema>;
export type CallerAudioEffects = z.infer<typeof CallerAudioEffectsSchema>;
export type ConversationCallSpec = z.infer<typeof ConversationCallSpecSchema>;

export type ObservedToolCall = z.infer<typeof ObservedToolCallSchema>;

export type PlatformConfig = z.infer<typeof PlatformConfigSchema>;
export type BlandPlatformConfig = Extract<PlatformConfig, { provider: "bland" }>;
export type LiveKitPlatformConfig = Extract<PlatformConfig, { provider: "livekit" }>;
export type VapiPlatformConfig = Extract<PlatformConfig, { provider: "vapi" }>;
export type RetellPlatformConfig = Extract<PlatformConfig, { provider: "retell" }>;
export type ElevenLabsPlatformConfig = Extract<PlatformConfig, { provider: "elevenlabs" }>;

export interface ChannelStats {
  bytesSent: number;
  bytesReceived: number;
  errorEvents: string[];
  connectLatencyMs: number;
}

export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;
export type PlatformTurn = z.infer<typeof PlatformTurnSchema>;

export type SignalQualityMetrics = z.infer<typeof SignalQualityMetricsSchema>;
export type ComponentLatency = z.infer<typeof ComponentLatencySchema>;

export type CallCost = z.infer<typeof CallCostSchema>;
export type ProviderWarning = z.infer<typeof ProviderWarningSchema>;
export type CallMetadata = z.infer<typeof CallMetadataSchema>;
export type CallTransfer = z.infer<typeof CallTransferSchema>;

export type ConversationMetrics = z.infer<typeof ConversationMetricsSchema>;
export type ConversationCallResult = z.infer<typeof ConversationCallResultSchema>;

export type RunJob = z.infer<typeof RunJobSchema>;
export type AgentSessionResponse = z.infer<typeof AgentSessionResponseSchema>;
