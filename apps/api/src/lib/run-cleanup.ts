import type { FastifyInstance } from "fastify";
import { eq, lt, and } from "drizzle-orm";
import { schema } from "@vent/db";
import { FLEET_ACTIVE_RUNS_KEY } from "@vent/shared";

function parseMsEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function registerRunCleanup(app: FastifyInstance): void {
  const cleanupEnabled = (process.env["RUN_CLEANUP_ENABLED"] ?? "true") !== "false";
  const CLEANUP_INTERVAL_MS = parseMsEnv("RUN_CLEANUP_INTERVAL_MS", 60_000);
  const STUCK_RUNNING_MS = parseMsEnv("RUN_STUCK_RUNNING_MS", 60 * 60_000);
  const STUCK_QUEUED_REMOTE_MS = parseMsEnv("RUN_STUCK_QUEUED_REMOTE_MS", 10 * 60_000);
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
        // 1. Runs stuck in "running" for too long (likely worker crash/restart)
        const runningCutoff = new Date(Date.now() - STUCK_RUNNING_MS);
        const stuckRunning = await app.db
          .update(schema.runs)
          .set({
            status: "fail",
            finished_at: new Date(),
            error_text: "Run timed out (server may have restarted)",
          })
          .where(
            and(
              eq(schema.runs.status, "running"),
              lt(schema.runs.started_at, runningCutoff),
            )
          )
          .returning({ id: schema.runs.id });

        for (const r of stuckRunning) {
          const removed = await app.redis.srem(FLEET_ACTIVE_RUNS_KEY, r.id).catch(() => 0);
          console.log(`[fleet-cap] SREM stuck-running run=${r.id} removed=${removed}`);
        }
        if (stuckRunning.length > 0) {
          const activeAfter = await app.redis.scard(FLEET_ACTIVE_RUNS_KEY).catch(() => -1);
          console.log(`Cleaned up ${stuckRunning.length} stuck running run(s) active=${activeAfter}: ${stuckRunning.map((r) => r.id).join(", ")}`);
        }

        // 2. Runs stuck in "queued" (worker never picked them up)
        const queuedCutoff = new Date(Date.now() - STUCK_QUEUED_REMOTE_MS);
        const stuckQueued = await app.db
          .update(schema.runs)
          .set({
            status: "fail",
            finished_at: new Date(),
            error_text: "Run timed out in queue — worker did not pick it up. Try again or check worker health.",
          })
          .where(
            and(
              eq(schema.runs.status, "queued"),
              lt(schema.runs.created_at, queuedCutoff),
            )
          )
          .returning({ id: schema.runs.id });

        for (const r of stuckQueued) {
          const removed = await app.redis.srem(FLEET_ACTIVE_RUNS_KEY, r.id).catch(() => 0);
          console.log(`[fleet-cap] SREM stuck-queued run=${r.id} removed=${removed}`);
        }
        if (stuckQueued.length > 0) {
          console.log(`Cleaned up ${stuckQueued.length} stuck queued run(s): ${stuckQueued.map((r) => r.id).join(", ")}`);
        }
      } catch (err) {
        console.error("Stuck run cleanup failed:", err);
      }
    }, CLEANUP_INTERVAL_MS);
  });
}
