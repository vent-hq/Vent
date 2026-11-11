import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  WorkerResultCallbackSchema,
  RunFailedCallbackSchema,
  RunEventCallbackSchema,
  RUNNER_CALLBACK_SIGNATURE_HEADER,
  RUNNER_CALLBACK_TIMESTAMP_HEADER,
  requireEnv,
  verifyCallback,
} from "@vent/shared";
import { broadcast } from "../lib/run-subscribers.js";
import { finalizeRun } from "../lib/finalize-run.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

function authorize(request: FastifyRequest, reply: FastifyReply, secret: string): boolean {
  const sig = request.headers[RUNNER_CALLBACK_SIGNATURE_HEADER];
  const ts = request.headers[RUNNER_CALLBACK_TIMESTAMP_HEADER];
  const sigStr = Array.isArray(sig) ? sig[0] : sig;
  const tsStr = Array.isArray(ts) ? ts[0] : ts;
  const rawBody = request.rawBody ?? "";

  // The route's own path, not request.url: query strings and encodings can't
  // change what was signed. Internal routes have no parameters.
  const path = request.routeOptions.url ?? "";
  const result = verifyCallback(request.method, path, rawBody, secret, sigStr, tsStr);
  if (!result.ok) {
    request.log.warn({ reason: result.reason, route: request.url }, "callback auth rejected");
    reply.status(401).send({ error: "Unauthorized" });
    return false;
  }
  return true;
}

export async function callbackRoutes(app: FastifyInstance) {
  const secret = requireEnv("RUNNER_CALLBACK_SECRET");

  // Internal callback routes can carry full conversation transcripts which
  // routinely exceed the global 1MB default.
  const INTERNAL_BODY_LIMIT = 10 * 1024 * 1024;

  // --- Run lifecycle event callback (from runner or worker) ---
  app.post("/internal/run-event", { bodyLimit: INTERNAL_BODY_LIMIT }, async (request, reply) => {
    if (!authorize(request, reply, secret)) return;

    const parsed = RunEventCallbackSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.format() });
    }
    const body = parsed.data;

    // Progress is only shown live; nothing stores it.
    broadcast(body.run_id, {
      run_id: body.run_id,
      event_type: body.event_type,
      message: body.message,
      metadata_json: body.metadata_json ?? null,
      created_at: new Date().toISOString(),
    });

    return reply.send({ ok: true });
  });

  // --- Worker failure callback (run failed before a result existed) ---
  app.post("/internal/run-failed", async (request, reply) => {
    if (!authorize(request, reply, secret)) return;

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
    if (!authorize(request, reply, secret)) return;

    const parsed = WorkerResultCallbackSchema.safeParse(request.body);
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
      result: body.conversation_result,
    });

    return reply.send({ ok: true, ended });
  });
}
