import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { schema } from "@vent/db";
import { cleanupSession, relaySessions } from "./transport.js";

async function agentSessionRoutes(app: FastifyInstance) {
  // POST /agent-sessions — Create a new agent session (relay tunnel)
  app.post("/agent-sessions", {
    preHandler: [app.verifyAccessToken],
  }, async (request, reply) => {
    const userId = request.userId!;
    const accessTokenId = request.accessTokenId!;

    const body = request.body as {
      config?: {
        adapter?: string;
        start_command?: string;
        health_endpoint?: string;
        agent_port?: number;
      };
    };

    if (!body?.config) {
      return reply.status(400).send({ error: "Missing config" });
    }

    const relayToken = randomUUID();
    const apiUrl = process.env["API_URL"]!;

    const [session] = await app.db
      .insert(schema.agentSessions)
      .values({
        user_id: userId,
        access_token_id: accessTokenId,
        relay_token: relayToken,
        status: "connecting",
        config_json: body.config,
      })
      .returning();

    const sessionId = session!.id;
    const config = body.config;

    return reply.send({
      session_id: sessionId,
      relay_token: relayToken,
      api_url: apiUrl,
      agent_port: config.agent_port ?? 3001,
      start_command: config.start_command ?? null,
      health_endpoint: config.health_endpoint ?? "/health",
    });
  });

  // POST /agent-sessions/:id/close — Close an agent session
  app.post<{ Params: { id: string } }>("/agent-sessions/:id/close", {
    preHandler: [app.verifyAccessToken],
  }, async (request, reply) => {
    const userId = request.userId!;
    const sessionId = request.params.id;

    const [session] = await app.db
      .select({ id: schema.agentSessions.id })
      .from(schema.agentSessions)
      .where(
        and(
          eq(schema.agentSessions.id, sessionId),
          eq(schema.agentSessions.user_id, userId),
        ),
      )
      .limit(1);

    if (!session) {
      return reply.status(404).send({ error: "Agent session not found" });
    }

    await app.db
      .update(schema.agentSessions)
      .set({ status: "closed", closed_at: new Date() })
      .where(
        and(
          eq(schema.agentSessions.id, sessionId),
          eq(schema.agentSessions.user_id, userId),
        ),
      );

    // Clean up in-memory relay session if it exists
    cleanupSession(sessionId, { closeControl: true, code: 1000, reason: "session_closed" });

    return reply.send({ status: "closed" });
  });
}

export { agentSessionRoutes };
