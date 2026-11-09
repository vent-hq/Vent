import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq, and } from "drizzle-orm";
import { schema } from "@vent/db";
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
  // reconnects to another API machine and replays the events it missed.
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
        accessTokenId: request.accessTokenId!,
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

  // --- Stream run events (SSE) ---
  app.get<{ Params: { id: string } }>("/runs/:id/stream", {
    ...accessTokenPreHandler,
    config: { rateLimit: { max: 300, timeWindow: "1 minute", keyGenerator: userOrIpKey } },
  }, async (request, reply) => {
    const { id } = request.params;

    const [run] = await app.db
      .select({ id: schema.runs.id, status: schema.runs.status })
      .from(schema.runs)
      .where(and(eq(schema.runs.id, id), eq(schema.runs.user_id, request.userId!)))
      .limit(1);

    if (!run) return reply.status(404).send({ error: "Run not found" });

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

    // Subscribe FIRST, then replay history. Without this ordering, an event
    // published between the history SELECT and subscribe is lost — the
    // runner-callback for short-lived runs frequently lands in that window,
    // leaving the CLI hanging forever. We buffer live events arriving during
    // history replay and drain them afterwards, deduplicating by event id.
    // The shared subscriber (run-subscribers.ts) is one IORedis connection
    // across all SSE clients on this instance — previously we opened one
    // connection per client, which exhausted Upstash limits under load.
    const seenIds = new Set<string | number>();
    const bufferedDuringHistory: Record<string, unknown>[] = [];
    let historyReplayed = false;
    let streamEnded = false;
    let unsubscribe: (() => void) | null = null;

    const finish = () => {
      if (streamEnded) return;
      streamEnded = true;
      openStreams.delete(finish);
      unsubscribe?.();
      reply.raw.end();
    };
    // A stream that reached this point after shutdown began ends right away.
    if (closing) return finish();
    openStreams.add(finish);

    const handleEvent = (event: Record<string, unknown>) => {
      // Hard guard: once finish() has been called the underlying stream is
      // ended. Any further write() throws "write after end". Drain loops
      // and live handlers can both invoke handleEvent so check here too.
      if (streamEnded) return;
      const eid =
        typeof event.id === "number" || typeof event.id === "string"
          ? event.id
          : null;
      if (eid != null) {
        if (seenIds.has(eid)) return;
        seenIds.add(eid);
      }
      write(event);
      if (event.event_type === "run_complete") {
        finish();
      }
    };

    unsubscribe = await subscribeToRun(id, (message) => {
      try {
        const event = JSON.parse(message) as Record<string, unknown>;
        if (!historyReplayed) {
          bufferedDuringHistory.push(event);
        } else {
          handleEvent(event);
        }
      } catch { /* ignore malformed */ }
    });
    // Shutdown can end the stream while it is still being set up.
    if (streamEnded) return unsubscribe();

    // Replay historical events from DB
    const history = await app.db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.run_id, id))
      .orderBy(schema.runEvents.created_at);
    if (streamEnded) return;

    let historyTerminal = false;
    for (const evt of history) {
      seenIds.add(evt.id);
      write({
        id: evt.id,
        run_id: evt.run_id,
        event_type: evt.event_type,
        message: evt.message,
        metadata_json: evt.metadata_json,
        created_at: evt.created_at.toISOString(),
      });
      if (evt.event_type === "run_complete") {
        historyTerminal = true;
      }
    }

    // History is replayed. Drain anything that arrived in the gap (deduped
    // by id), then switch to live-mode. handleEvent is reentrancy-safe:
    // a terminal buffered event triggers finish() and subsequent calls
    // become no-ops via the streamEnded guard.
    for (const buffered of bufferedDuringHistory) {
      if (streamEnded) break;
      handleEvent(buffered);
    }
    bufferedDuringHistory.length = 0;
    historyReplayed = true;

    // If finish() already ran (terminal event in history or buffered drain),
    // skip heartbeat / close-listener setup entirely — they would otherwise
    // arm a 30s interval against an ended stream.
    if (streamEnded) return;

    // If history already contains a terminal event (or the run is terminal
    // in DB and never emitted a terminal event — shouldn't happen but defends
    // against pre-event-system runs), close immediately.
    if (historyTerminal || ["pass", "fail", "cancelled"].includes(run.status)) {
      const [latest] = await app.db
        .select({ status: schema.runs.status })
        .from(schema.runs)
        .where(eq(schema.runs.id, id))
        .limit(1);
      if (latest && ["pass", "fail", "cancelled"].includes(latest.status)) {
        finish();
        return;
      }
    }

    const heartbeat = setInterval(() => {
      // Defensive: if the stream has been closed since this interval armed,
      // a write throws "write after end". Stop the interval first.
      if (streamEnded) {
        clearInterval(heartbeat);
        return;
      }
      reply.raw.write(": heartbeat\n\n");
    }, 30_000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      finish();
    });
  });

  // ----- helper used below -----

  // --- Get run status (JSON) ---
  app.get<{ Params: { id: string } }>("/runs/:id", accessTokenPreHandler, async (request, reply) => {
    const [run] = await app.db
      .select()
      .from(schema.runs)
      .where(and(eq(schema.runs.id, request.params.id), eq(schema.runs.user_id, request.userId!)))
      .limit(1);

    if (!run) return reply.status(404).send({ error: "Run not found" });

    const results = await app.db
      .select()
      .from(schema.scenarioResults)
      .where(eq(schema.scenarioResults.run_id, run.id));

    return reply.send({
      id: run.id,
      status: run.status,
      created_at: run.created_at,
      started_at: run.started_at,
      finished_at: run.finished_at,
      duration_ms: run.duration_ms,
      error_text: run.error_text,
      aggregate: run.aggregate_json,
      results: results.map((r) => r.metrics_json),
    });
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
