import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { schema, type Database } from "@vent/db";
import type { AccessCredentials } from "@vent/shared";

type CredentialDb = Pick<Database, "insert" | "select">;

export async function createRefreshCredential(db: CredentialDb, userId: string, name: string) {
  const refreshToken = `vent_${randomBytes(24).toString("hex")}`;
  const tokenHash = createHash("sha256").update(refreshToken).digest("hex");
  const [row] = await db.insert(schema.accessTokens).values({
    user_id: userId, name, token_hash: tokenHash, prefix: refreshToken.slice(0, 12),
  }).returning();
  return { row: row!, refreshToken };
}

export async function findRefreshCredential(db: CredentialDb, refreshToken: string) {
  const tokenHash = createHash("sha256").update(refreshToken).digest("hex");
  const [row] = await db.select().from(schema.accessTokens).where(and(
    eq(schema.accessTokens.token_hash, tokenHash), isNull(schema.accessTokens.revoked_at),
  )).limit(1);
  return row;
}

export async function issueAccessCredentials(
  app: FastifyInstance,
  row: { id: string; user_id: string },
  refreshToken: string,
): Promise<AccessCredentials> {
  return {
    access_token: await app.issueAccessToken({ userId: row.user_id, accessTokenId: row.id }),
    refresh_token: refreshToken,
  };
}
