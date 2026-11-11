import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq, and } from "drizzle-orm";
import { schema } from "@vent/db";
import { buildRunOutput } from "@vent/shared";
import { subscribeToRun } from "../lib/run-subscribers.js";
import { finalizeRun } from "../lib/finalize-run.js";
import { RunSubmitSchema, submitRun, SubmitRunConfigError, FleetCapacityError } from "../lib/run-submit.js";
import { ipKey } from "../plugins/rate-limit.js";

export async function runRoutes(app: FastifyInstance) {
  const accessTokenPreHandler = { preHandler: app.verifyAccessToken };

  // A request whose access token verifies is limited per user, wherever it
  // connects from, so users behind one IP (CI runners) don't share a budget.
  // Anything else, including forged tokens, is limited per connecting IP.
  const userOrIpKey = async (request: FastifyRequest) => {
    const userId = await app.accessTokenUserId(request);
    return userId ? `user:${userId}` : ipKey(request);
  };

  // A CLI waits on its run's stream until run_complete, so the stream never
  // ends by itself and would hold shutdown open. End them first: the CLI
  // reconnects to another API machine and gets the result from the run row.
  const openStreams = new Set<() => void>();
  let closing = false;
  app.addHook("preClose", async () => {
    closing = true;
    for (const end of [...openStreams]) end();
  });

  // --- Submit a run with full call config (used by CLI) ---
  app.post("/runs/submit", {
    ...accessTokenPreHandler,
    config: { rateLimit: { max: 50, timeWindow: "1 minute", keyGenerator: userOrIpKey } },
  }, async (request, reply) => {
    const parsed = RunSubmitSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid config",
        details: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }

    let result;
    try {
      result = await submitRun(app, {
        userId: request.userId!,
        config: parsed.data.config,
        idempotencyKey: parsed.data.idempotency_key,
        agentSessionId: parsed.data.agent_session_id,
      });
    } catch (err) {
      if (err instanceof FleetCapacityError) {
        return reply.status(429).send({
          error: err.message,
          code: "FLEET_CAPACITY",
          retry_after: 10,
        });
      }
      if (err instanceof SubmitRunConfigError) {
        return reply.status(err.statusCode).send({ error: err.message });
      }
      throw err;
    }

    return reply.status(201).send(result);
  });

  const TERMINAL_STATUSES = ["pass", "fail", "cancelled"];
  const loadRun = async (id: string, userId: string) => {
    const [run] = await app.db
      .select()
      .from(schema.runs)
      .where(and(eq(schema.runs.id, id), eq(schema.runs.user_id, userId)))
      .limit(1);
    return run;
  };

  // --- Stream a run: live progress, then the result (SSE) ---
  app.get<{ Params: { id: string } }>("/runs/:id/stream", {
    ...accessTokenPreHandler,
    config: { rateLimit: { max: 300, timeWindow: "1 minute", keyGenerator: userOrIpKey } },
  }, async (request, reply) => {
    const { id } = request.params;
    const userId = request.userId!;

    if (!(await loadRun(id, userId))) return reply.status(404).send({ error: "Run not found" });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Tell nginx/Fly proxies not to buffer SSE — without this, first chunks
      // can be held back up to 8KB before the client sees anything.
      "X-Accel-Buffering": "no",
    });

    const write = (event: Record<string, unknown>) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    let streamEnded = false;
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const finish = () => {
      if (streamEnded) return;
      streamEnded = true;
      openStreams.delete(finish);
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
      reply.raw.end();
    };
    // A stream that reached this point after shutdown began ends right away.
    if (closing) return finish();
    openStreams.add(finish);

    // The run row holds the only copy of the result: send it and end the stream.
    let completing = false;
    const complete = async () => {
      if (completing || streamEnded) return;
      completing = true;
      const run = await loadRun(id, userId);
      if (run && !streamEnded) {
        write({ run_id: id, event_type: "run_complete", result: buildRunOutput(run) });
      }
      finish();
    };

    // Subscribe before reading the run's status: a run that ends between the
    // read and the subscribe would otherwise never reach this client. Short
    // runs often end before the CLI connects; a CLI that reconnects (API
    // deploy, network drop) gets the result the same way.
    unsubscribe = await subscribeToRun(id, (message) => {
      try {
        const event = JSON.parse(message) as Record<string, unknown>;
        if (event.event_type === "run_complete") void complete();
        else if (!streamEnded) write(event);
      } catch { /* ignore malformed */ }
    });
    if (streamEnded) return;

    const run = await loadRun(id, userId);
    if (run && TERMINAL_STATUSES.includes(run.status)) return complete();

    heartbeat = setInterval(() => {
      if (!streamEnded) reply.raw.write(": heartbeat\n\n");
    }, 30_000);
    request.raw.on("close", finish);
  });

  // --- Get a run's result: the same JSON the stream ends with ---
  app.get<{ Params: { id: string } }>("/runs/:id", accessTokenPreHandler, async (request, reply) => {
    const run = await loadRun(request.params.id, request.userId!);
    if (!run) return reply.status(404).send({ error: "Run not found" });
    return reply.send(buildRunOutput(run));
  });

  // --- Stop/cancel a run ---
  app.post<{ Params: { id: string } }>(
    "/runs/:id/stop",
    accessTokenPreHandler,
    async (request, reply) => {
      const { id } = request.params;

      const [run] = await app.db
        .select()
        .from(schema.runs)
        .where(
          and(
            eq(schema.runs.id, id),
            eq(schema.runs.user_id, request.userId!),
          )
        )
        .limit(1);

      if (!run) {
        return reply.status(404).send({ error: "Run not found" });
      }

      if (run.status === "pass" || run.status === "fail" || run.status === "cancelled") {
        return reply.status(409).send({
          error: `Run already ${run.status}`,
          status: run.status,
        });
      }

      // Flag first: if a worker has (or is about to claim) the run, it aborts
      // the call, hangs up, and ends the run as cancelled itself.
      await app.redis.set(`vent:cancelled:${id}`, "1", "EX", 600);

      const ended = await finalizeRun(app, {
        runId: id,
        status: "cancelled",
        from: ["queued"],
        errorText: "Cancelled by user",
      });
      if (!ended) {
        const [current] = await app.db
          .select({ status: schema.runs.status })
          .from(schema.runs)
          .where(eq(schema.runs.id, id))
          .limit(1);
        if (current?.status === "running") {
          return reply.status(202).send({ id, status: "cancelling" });
        }
        return reply.status(409).send({
          error: `Run already ${current?.status ?? "ended"}`,
          status: current?.status ?? "unknown",
        });
      }

      await app.runQueue.remove(id).catch(() => 0);
      return reply.send({ id, status: "cancelled" });
    }
  );
}
