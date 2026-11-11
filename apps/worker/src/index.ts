import IORedis from "ioredis";
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFileSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { Worker, type Job } from "bullmq";
import {
  RUN_JOB_LOCK_DURATION_MS,
  RUN_JOB_LOCK_RENEW_MS,
  RUN_JOB_STALLED_INTERVAL_MS,
  RUN_QUEUE_NAME,
  envPositiveInt,
  requireEnv,
} from "@vent/shared";
import { checkDatabase, executeRun, LostCallLock, type RunJob } from "./jobs/run-executor.js";
import { cancelAllCalls } from "./call-supervisor.js";
import { createWorkerMetrics } from "./metrics.js";

const LOG_DIR = "/tmp/vent-run-logs";
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

const redisUrl = requireEnv("REDIS_URL");
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
// Dedicated connection for BullMQ Workers (blocking BLPOP). Sharing with
// the general-purpose `connection` causes BullMQ to log a deprecation and,
// under sustained load, can deadlock blocking commands behind non-blocking ones.
const workerConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const totalConcurrency = envPositiveInt("WORKER_TOTAL_CONCURRENCY");
const workerMetricsPort = envPositiveInt("WORKER_METRICS_PORT", 9091);
const runLogStore = new AsyncLocalStorage<string[]>();
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);
const workerMetrics = createWorkerMetrics({
  connection,
  metricsPort: workerMetricsPort,
  totalConcurrency,
});

function appendRunLog(line: string): void {
  runLogStore.getStore()?.push(line);
}

console.log = (...args: unknown[]) => {
  const line = args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  appendRunLog(line);
  originalConsoleLog(...args);
};

console.error = (...args: unknown[]) => {
  const line = args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  appendRunLog(`[ERROR] ${line}`);
  originalConsoleError(...args);
};

const machineId = process.env["FLY_MACHINE_ID"] ?? `${hostname()}-${process.pid}`;

const lockLost = new Map<string, AbortController>();

async function processRun(job: Job<RunJob>): Promise<void> {
  const data = job.data;
  const lost = new AbortController();
  lockLost.set(job.id!, lost);
  console.log(
    `Processing run ${data.run_id} (adapter: ${data.adapter ?? "unknown"}${data.agent_session_id ? ", session" : ""})`,
  );

  // Capture all console output for the run so we can dump it at the end.
  // Fly only keeps the last 100 log lines — this ensures we can see the full run.
  const logLines: string[] = [];

  workerMetrics.onJobStart();
  try {
    await runLogStore.run(logLines, () => executeRun(data, lost.signal));
  } finally {
    lockLost.delete(job.id!);
    workerMetrics.onJobFinish();
    const logPath = `${LOG_DIR}/${data.run_id}.log`;
    try {
      writeFileSync(logPath, logLines.join("\n") + "\n");
      originalConsoleLog(`[run-log] Full log written to ${logPath} (${logLines.length} lines)`);
    } catch (e) {
      originalConsoleError(`[run-log] Failed to write log: ${e}`);
    }
  }
}

const worker = new Worker<RunJob>(RUN_QUEUE_NAME, processRun, {
  connection: workerConnection,
  concurrency: totalConcurrency,
  lockDuration: RUN_JOB_LOCK_DURATION_MS,
  lockRenewTime: RUN_JOB_LOCK_RENEW_MS,
  stalledInterval: RUN_JOB_STALLED_INTERVAL_MS,
  // Never redial a call whose lock expired. The API handles its stalled event.
  maxStalledCount: 0,
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86_400, count: 5000 },
  autorun: false,
});
worker.on("completed", (job) => console.log(`Run ${job.id} completed`));
worker.on("failed", (job, err) => console.error(`Run ${job?.id} failed:`, err.message));
worker.on("error", (err) => console.error("[worker] BullMQ error:", err.message));
// The API already failed these runs; hang up.
worker.on("lockRenewalFailed", (jobIds) => {
  for (const id of jobIds) {
    console.error(`Run ${id}: could not renew its queue lock, stopping the call`);
    lockLost.get(id)?.abort(new LostCallLock());
  }
});

// /health stays 503 until this finishes, so a deploy whose worker can't reach
// Postgres or Redis stops at the first machine instead of replacing them all.
async function start() {
  await checkDatabase();
  await worker.waitUntilReady();
  void worker.run();
  workerMetrics.markReady();
  console.log(
    `Vent Worker started (machine: ${machineId}, total concurrency: ${totalConcurrency})`,
  );
}

start().catch((err) => {
  console.error("Failed to start worker:", err);
  process.exit(1);
});

// Fly sends SIGTERM, then SIGKILLs after kill_timeout (5m, apps/worker/fly.toml).
// Calls still running this long after SIGTERM are asked to hang up, leaving
// them the cancel grace period (45s) to stop and time to report results.
const CANCEL_CALLS_AFTER_MS = 3 * 60_000;

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  const drainStart = Date.now();
  console.log(`[shutdown] ${signal} received — draining active jobs...`);

  // Log drain progress every 15s so operators can see a deploy that's
  // taking a while is actually progressing (vs. hung).
  const progressTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - drainStart) / 1000);
    console.log(`[shutdown] still draining (${seconds}s elapsed)...`);
  }, 15_000);

  const cancelTimer = setTimeout(() => {
    console.log("[shutdown] calls still running — asking them to hang up");
    cancelAllCalls();
  }, CANCEL_CALLS_AFTER_MS);

  try {
    // worker.close() stops taking new calls and waits for running ones. Calls
    // that finish within CANCEL_CALLS_AFTER_MS end normally; later ones are
    // cancelled and still report their partial result.
    await worker.close();
  } catch (err) {
    console.error(`[shutdown] worker.close failed:`, (err as Error).message);
  } finally {
    clearInterval(progressTimer);
    clearTimeout(cancelTimer);
  }

  await workerMetrics.close().catch((err) => {
    console.error(`[shutdown] worker metrics close failed:`, (err as Error).message);
  });
  connection.disconnect();
  workerConnection.disconnect();

  const totalSeconds = Math.floor((Date.now() - drainStart) / 1000);
  console.log(`[shutdown] drain complete (${totalSeconds}s)`);
  process.exit(0);
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
