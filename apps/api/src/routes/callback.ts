import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { schema } from "@vent/db";
import {
  RunnerCallbackV2Schema,
  RunFailedCallbackSchema,
  RunEventCallbackSchema,
  CallProgressCallbackSchema,
  RUNNER_CALLBACK_SIGNATURE_HEADER,
  RUNNER_CALLBACK_TIMESTAMP_HEADER,
  verifyCallback,
} from "@vent/shared";
import { broadcast } from "../lib/run-subscribers.js";
import { finalizeRun } from "../lib/finalize-run.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

function authorize(request: FastifyRequest, reply: FastifyReply): boolean {
  const expectedSecret = process.env["RUNNER_CALLBACK_SECRET"];
  if (!expectedSecret) {
    reply.status(500).send({ error: "Callback secret not configured" });
    return false;
  }

  const sig = request.headers[RUNNER_CALLBACK_SIGNATURE_HEADER];
  const ts = request.headers[RUNNER_CALLBACK_TIMESTAMP_HEADER];
  const sigStr = Array.isArray(sig) ? sig[0] : sig;
  const tsStr = Array.isArray(ts) ? ts[0] : ts;
  const rawBody = request.rawBody ?? "";

  // The route's own path, not request.url: query strings and encodings can't
  // change what was signed. Internal routes have no parameters.
  const path = request.routeOptions.url ?? "";
  const result = verifyCallback(request.method, path, rawBody, expectedSecret, sigStr, tsStr);
  if (!result.ok) {
    request.log.warn({ reason: result.reason, route: request.url }, "callback auth rejected");
    reply.status(401).send({ error: "Unauthorized" });
    return false;
  }
  return true;
}

export async function callbackRoutes(app: FastifyInstance) {
  // Internal callback routes can carry full conversation transcripts which
  // routinely exceed the global 1MB default.
  const INTERNAL_BODY_LIMIT = 10 * 1024 * 1024;

  // --- Run lifecycle event callback (from runner or worker) ---
  app.post("/internal/run-event", { bodyLimit: INTERNAL_BODY_LIMIT }, async (request, reply) => {
    if (!authorize(request, reply)) return;

    const parsed = RunEventCallbackSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.format() });
    }
    const body = parsed.data;

    const [inserted] = await app.db
      .insert(schema.runEvents)
      .values({
        run_id: body.run_id,
        event_type: body.event_type,
        message: body.message,
        metadata_json: body.metadata_json ?? null,
      })
      .returning();

    broadcast(body.run_id, {
      id: inserted!.id,
      run_id: body.run_id,
      event_type: body.event_type,
      message: body.message,
      metadata_json: body.metadata_json ?? null,
      created_at: inserted!.created_at.toISOString(),
    });

    return reply.send({ ok: true });
  });

  // --- Per-call progress callback (from runner) ---
  app.post("/internal/call-progress", { bodyLimit: INTERNAL_BODY_LIMIT }, async (request, reply) => {
    if (!authorize(request, reply)) return;

    const parsed = CallProgressCallbackSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.format() });
    }
    const body = parsed.data;

    const progressMessage = `${body.call_name}: ${body.status} (${body.duration_ms}ms)`;
    const progressMetadata: Record<string, unknown> = {
      call_name: body.call_name,
      call_type: body.call_type,
      status: body.status,
      duration_ms: body.duration_ms,
      completed: body.completed,
      total: body.total,
    };
    if (body.result) {
      progressMetadata.result = body.result;
    }

    const [progressEvent] = await app.db
      .insert(schema.runEvents)
      .values({
        run_id: body.run_id,
        event_type: "call_completed",
        message: progressMessage,
        metadata_json: progressMetadata,
      })
      .returning();

    broadcast(body.run_id, {
      id: progressEvent!.id,
      run_id: body.run_id,
      event_type: "call_completed",
      message: progressMessage,
      metadata_json: progressMetadata,
      created_at: progressEvent!.created_at.toISOString(),
    });

    return reply.send({ ok: true });
  });

  // --- Worker failure callback (run failed before a result existed) ---
  app.post("/internal/run-failed", async (request, reply) => {
    if (!authorize(request, reply)) return;

    const parsed = RunFailedCallbackSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.format() });
    }
    const body = parsed.data;

    const ended = await finalizeRun(app, {
      runId: body.run_id,
      status: "fail",
      from: ["queued", "running"],
      errorText: body.error_text,
    });

    return reply.send({ ok: true, ended });
  });

  // --- Runner results callback ---
  app.post("/internal/runner-callback", { bodyLimit: INTERNAL_BODY_LIMIT }, async (request, reply) => {
    if (!authorize(request, reply)) return;

    const parsed = RunnerCallbackV2Schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.format() });
    }
    const body = parsed.data;

    // A retried callback (lost response) or one arriving after another path
    // already ended the run matches no rows and is acknowledged as a no-op.
    const ended = await finalizeRun(app, {
      runId: body.run_id,
      status: body.status,
      from: ["running"],
      errorText: body.error_text,
      result: { conversation_result: body.conversation_result, aggregate: body.aggregate },
    });

    return reply.send({ ok: true, ended });
  });
}
