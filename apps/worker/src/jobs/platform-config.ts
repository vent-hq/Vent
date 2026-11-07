import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@vent/db";
import type { AdapterType, PlatformConfig } from "@vent/shared";
import {
  decryptPlatformConfig,
  type EncryptedPlatformConfig,
} from "@vent/platform-connections";

export async function loadRunPlatformConfig(
  db: Database,
  runId: string,
  userId: string,
  adapter: AdapterType,
): Promise<PlatformConfig | undefined> {
  if (adapter === "websocket") {
    return undefined;
  }

  if (!userId) {
    throw new Error("Run owner is required to load platform configuration");
  }

  // Match both IDs so another customer cannot load this run's credentials.
  const [run] = await db
    .select({
      platform_config_encrypted: schema.runs.platform_config_encrypted,
    })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.id, runId),
        eq(schema.runs.user_id, userId),
      ),
    )
    .limit(1);

  const encryptedConfig = run?.platform_config_encrypted;

  if (!encryptedConfig) {
    throw new Error("Run platform configuration not found");
  }

  const platformConfig = decryptPlatformConfig(
    encryptedConfig as EncryptedPlatformConfig,
  );

  if (platformConfig.provider !== adapter) {
    throw new Error("Run platform provider does not match adapter");
  }

  return platformConfig;
}
