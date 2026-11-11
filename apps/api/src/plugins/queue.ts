import fp from "fastify-plugin";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { finalizeRun } from "../lib/finalize-run.js";
import { RunQueueMonitor } from "../lib/run-queue-monitor.js";
import { RUN_QUEUE_NAME, requireEnv, type RunJob } from "@vent/shared";

declare module "fastify" {
  interface FastifyInstance {
    /** The one queue every run's job goes to (worker machines take from it). */
    runQueue: Queue<RunJob>;
    redis: IORedis;
  }
}

export const queuePlugin = fp(async (app) => {
  const redisUrl = requireEnv("REDIS_URL");
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

  app.decorate("redis", connection);

  const runQueue = new Queue<RunJob>(RUN_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      // Voice calls are non-idempotent (each execution = a real billed phone call).
      // Never let BullMQ auto-retry on a thrown error.
      attempts: 1,
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86_400, count: 5000 },
    },
  });
  app.decorate("runQueue", runQueue);

  const monitor = new RunQueueMonitor(connection, async (runId, reason) => {
    await finalizeRun(app, {
      runId,
      status: "fail",
      from: ["queued", "running"],
      errorText: reason,
    });
  }, error => app.log.error({ err: error }, "Run queue monitoring failed"));

  app.addHook("onClose", async () => {
    await monitor.close();
    await runQueue.close();
    connection.disconnect();
  });
  await monitor.start();
});
