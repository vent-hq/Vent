import type { FastifyInstance } from "fastify";
import { lt, and, sql } from "drizzle-orm";
import { schema } from "@vent/db";
import { finalizeRun } from "./finalize-run.js";
import { enqueueRun } from "./enqueue-run.js";

function parseMsEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

interface SweepLimits {
  stuckRunningMs: number;
  stuckQueuedMs: number;
  /** A queued run younger than this may still be mid-submit (saved, job about
   *  to be added), so it is not checked for a missing job yet. */
  unqueuedGraceMs: number;
}

// One cleanup pass. Every API machine runs it; finalizeRun and the job ID make
// two machines sweeping the same run harmless.
async function sweepRuns(app: FastifyInstance, limits: SweepLimits): Promise<void> {
  const now = Date.now();

  // 1. Runs stuck in "running" for too long (likely worker crash/restart)
  const stuckRunning = await app.db
    .select({ id: schema.runs.id })
    .from(schema.runs)
    .where(
      and(
        // Literal status (not a bound parameter) so even a reused query plan can use runs_open_idx.
        sql`${schema.runs.status} = 'running'`,
        lt(schema.runs.started_at, new Date(now - limits.stuckRunningMs)),
      ),
    );
  for (const r of stuckRunning) {
    await finalizeRun(app, {
      runId: r.id,
      status: "fail",
      from: ["running"],
      errorText: "Run timed out (server may have restarted)",
    });
  }

  // 2. Runs stuck in "queued" (worker never picked them up). Remove the
  // job too, so a worker that recovers later can't place the call.
  const stuckQueued = await app.db
    .select({ id: schema.runs.id })
    .from(schema.runs)
    .where(
      and(
        sql`${schema.runs.status} = 'queued'`,
        lt(schema.runs.created_at, new Date(now - limits.stuckQueuedMs)),
      ),
    );
  for (const r of stuckQueued) {
    await finalizeRun(app, {
      runId: r.id,
      status: "fail",
      from: ["queued"],
      errorText: "Run timed out in queue — worker did not pick it up. Try again or check worker health.",
    });
    await app.runQueue.remove(r.id).catch((err: Error) => {
      app.log.warn({ run_id: r.id, error: err.message }, "Failed to remove stuck queued job");
    });
  }

  // 3. Queued runs with no job. Saving a run (Postgres) and adding its job
  // (Redis) can't be one transaction, so an API that dies between the two
  // leaves a run no worker will ever see. Add the job from the saved run.
  const queued = await app.db
    .select({
      id: schema.runs.id,
      user_id: schema.runs.user_id,
      test_spec_json: schema.runs.test_spec_json,
      agent_session_id: schema.runs.agent_session_id,
    })
    .from(schema.runs)
    .where(
      and(
        sql`${schema.runs.status} = 'queued'`,
        lt(schema.runs.created_at, new Date(now - limits.unqueuedGraceMs)),
      ),
    );
  for (const r of queued) {
    if (await app.runQueue.getJob(r.id)) continue;
    await enqueueRun(app, r);
    app.log.warn({ run_id: r.id }, "Queued run had no job (submit was interrupted); added it");
  }
}

export function registerRunCleanup(app: FastifyInstance): void {
  const cleanupEnabled = (process.env["RUN_CLEANUP_ENABLED"] ?? "true") !== "false";
  const CLEANUP_INTERVAL_MS = parseMsEnv("RUN_CLEANUP_INTERVAL_MS", 60_000);
  const limits: SweepLimits = {
    stuckRunningMs: parseMsEnv("RUN_STUCK_RUNNING_MS", 60 * 60_000),
    stuckQueuedMs: parseMsEnv("RUN_STUCK_QUEUED_REMOTE_MS", 10 * 60_000),
    unqueuedGraceMs: 30_000,
  };
  let cleanupInterval: ReturnType<typeof setInterval> | undefined;

  app.addHook("onClose", async () => {
    if (cleanupInterval) clearInterval(cleanupInterval);
  });

  app.addHook("onListen", async () => {
    if (!cleanupEnabled) {
      console.log("Run cleanup disabled via RUN_CLEANUP_ENABLED=false");
      return;
    }

    cleanupInterval = setInterval(async () => {
      try {
        await sweepRuns(app, limits);
      } catch (err) {
        console.error("Stuck run cleanup failed:", err);
      }
    }, CLEANUP_INTERVAL_MS);
  });
}
