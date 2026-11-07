import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  PlatformConfigSchema,
  type PlatformConfig,
  type PlatformProvider,
} from "@vent/shared";

const PLATFORM_CONNECTIONS_MASTER_KEY_ENV = "PLATFORM_CONNECTIONS_MASTER_KEY";
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export interface EncryptedPlatformConfig {
  alg: typeof ENCRYPTION_ALGORITHM;
  iv: string;
  tag: string;
  ciphertext: string;
}

function normalizeMasterKey(raw: string): Buffer {
  const trimmed = raw.trim();
  // Require a 32-byte key encoded as 64 hex characters.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  throw new Error(
    `${PLATFORM_CONNECTIONS_MASTER_KEY_ENV} must be exactly 64 hex characters (generate with: openssl rand -hex 32)`,
  );
}

function loadMasterKey(): Buffer {
  const raw = process.env[PLATFORM_CONNECTIONS_MASTER_KEY_ENV];
  if (!raw) {
    throw new Error(`${PLATFORM_CONNECTIONS_MASTER_KEY_ENV} is required for platform configuration encryption`);
  }
  return normalizeMasterKey(raw);
}

function requiredFieldError(field: string, provider: PlatformProvider): Error {
  return new Error(`${provider} configuration requires ${field}`);
}

export function validateResolvedPlatformConfig(platform: PlatformConfig): void {
  switch (platform.provider) {
    case "vapi":
      if (!platform.vapi_api_key) throw requiredFieldError("vapi_api_key", platform.provider);
      if (!platform.vapi_assistant_id) throw requiredFieldError("vapi_assistant_id", platform.provider);
      return;
    case "retell":
      if (!platform.retell_api_key) throw requiredFieldError("retell_api_key", platform.provider);
      if (!platform.retell_agent_id) throw requiredFieldError("retell_agent_id", platform.provider);
      return;
    case "elevenlabs":
      if (!platform.elevenlabs_api_key) throw requiredFieldError("elevenlabs_api_key", platform.provider);
      if (!platform.elevenlabs_agent_id) throw requiredFieldError("elevenlabs_agent_id", platform.provider);
      return;
    case "livekit":
      if (!platform.livekit_api_key) throw requiredFieldError("livekit_api_key", platform.provider);
      if (!platform.livekit_api_secret) throw requiredFieldError("livekit_api_secret", platform.provider);
      if (!platform.livekit_url) throw requiredFieldError("livekit_url", platform.provider);
      return;
    case "bland":
      if (!platform.bland_api_key) throw requiredFieldError("bland_api_key", platform.provider);
      if (!platform.bland_pathway_id && !platform.task && !platform.persona_id) {
        throw new Error("Bland configuration requires bland_pathway_id, persona_id, or task");
      }
      return;
  }
}

export function encryptPlatformConfig(platform: PlatformConfig): EncryptedPlatformConfig {
  const parsedConfig = PlatformConfigSchema.parse(platform);
  validateResolvedPlatformConfig(parsedConfig);
  const key = loadMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(parsedConfig), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: ENCRYPTION_ALGORITHM,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptPlatformConfig(envelope: EncryptedPlatformConfig): PlatformConfig {
  if (envelope.alg !== ENCRYPTION_ALGORITHM) {
    throw new Error("Unsupported platform configuration encryption algorithm");
  }
  const key = loadMasterKey();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64"),
    { authTagLength: 16 },
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  const platform = PlatformConfigSchema.parse(JSON.parse(plaintext.toString("utf8")));
  validateResolvedPlatformConfig(platform);
  return platform;
}
