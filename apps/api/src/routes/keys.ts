import type { FastifyInstance } from "fastify";
import { eq, and, isNull, desc } from "drizzle-orm";
import { schema } from "@vent/db";
import { createRefreshCredential } from "../lib/access-credentials.js";

export async function keyRoutes(app: FastifyInstance) {
  const authPreHandler = { preHandler: app.verifyAuth };
  // Mutating routes additionally enforce Origin allowlist for cookie-authed
  // requests so a malicious site can't trigger key creation/revocation via
  // an in-browser form POST against a signed-in dashboard user.
  const mutatingPreHandler = { preHandler: app.verifyAuthAndCsrf };

  app.post("/keys", { preHandler: app.verifyCredentialIssuer }, async (request, reply) => {
    const body = request.body as { name?: string } | undefined;
    const name = body?.name ?? "default";

    const { row, refreshToken } = await createRefreshCredential(app.db, request.userId!, name);

    return reply.status(201).send({
      id: row.id,
      refresh_token: refreshToken,
      name,
      prefix: row.prefix,
      created_at: row.created_at,
    });
  });

  app.get("/keys", authPreHandler, async (request, reply) => {
    const rows = await app.db
      .select({
        id: schema.accessTokens.id,
        name: schema.accessTokens.name,
        prefix: schema.accessTokens.prefix,
        created_at: schema.accessTokens.created_at,
        revoked_at: schema.accessTokens.revoked_at,
      })
      .from(schema.accessTokens)
      .where(eq(schema.accessTokens.user_id, request.userId!))
      .orderBy(desc(schema.accessTokens.created_at));

    const keys = rows.map((row) => ({
      ...row,
      active: row.revoked_at === null,
    }));

    return reply.send(keys);
  });

  app.delete<{ Params: { id: string } }>(
    "/keys/:id",
    mutatingPreHandler,
    async (request, reply) => {
      const { id } = request.params;

      const [updated] = await app.db
        .update(schema.accessTokens)
        .set({ revoked_at: new Date() })
        .where(
          and(
            eq(schema.accessTokens.id, id),
            eq(schema.accessTokens.user_id, request.userId!),
            isNull(schema.accessTokens.revoked_at),
          )
        )
        .returning();

      if (!updated) {
        return reply
          .status(404)
          .send({ error: "Access token not found or already revoked" });
      }

      return reply.send({ id: updated.id, revoked_at: updated.revoked_at });
    }
  );
}
