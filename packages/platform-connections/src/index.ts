import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { PlatformConfigSchema, type PlatformConfig } from "@vent/shared";

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

// Callers pass a config already parsed and checked for missing fields (the
// API's run submit schema); this only encrypts it.
export function encryptPlatformConfig(platform: PlatformConfig): EncryptedPlatformConfig {
  const key = loadMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(platform), "utf8");
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
  return PlatformConfigSchema.parse(JSON.parse(plaintext.toString("utf8")));
}
