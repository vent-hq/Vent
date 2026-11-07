import IORedis from "ioredis";
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFileSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import type { Job } from "bullmq";
import { requireEnv } from "@vent/shared";
import { WebhookServer } from "@vent/adapters";
import { executeRun } from "./jobs/run-executor.js";
import { createWorkerMetrics } from "./metrics.js";
import {
  PerUserQueueRuntime,
  type RunJobData,
} from "./queue-runtime.js";

const LOG_DIR = "/tmp/vent-run-logs";
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function parseRequiredPositiveIntEnv(name: string): number {
  const raw = process.env[name];
  if (!raw) {
    throw new Error(`${name} must be set`);
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

const redisUrl = requireEnv("REDIS_URL");
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
// Dedicated connection for BullMQ Workers (blocking BLPOP). Sharing with
// the general-purpose `connection` causes BullMQ to log a deprecation and,
// under sustained load, can deadlock blocking commands behind non-blocking ones.
const workerConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const totalConcurrency = parseRequiredPositiveIntEnv("WORKER_TOTAL_CONCURRENCY");
const workerMetricsPort = parsePositiveIntEnv("WORKER_METRICS_PORT", 9091);
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

async function processRun(
  queueName: string,
  data: RunJobData,
  _job: Job<RunJobData>,
  _token: string | undefined,
): Promise<void> {
  console.log(
    `[${queueName}] Processing run ${data.run_id} (adapter: ${data.adapter ?? "unknown"}${data.agent_session_id ? ", session" : ""})`,
  );

  // Capture all console output for the run so we can dump it at the end.
  // Fly only keeps the last 100 log lines — this ensures we can see the full run.
  const logLines: string[] = [];

  // Note: BullMQ's LockManager auto-renews the job lock every lockDuration/2
  // for the full duration of processing. We do NOT need a manual extendLock
  // heartbeat — an earlier version had one and it was a redundant duplicate
  // that just spammed Redis. maxStalledCount: 0 (in queue-runtime.ts) is
  // what actually prevents replay-on-stall.

  workerMetrics.onJobStart();
  try {
    await runLogStore.run(logLines, async () => {
      await executeRun({
        run_id: data.run_id,
        user_id: data.user_id,
        adapter: data.adapter,
        call_spec: data.call_spec,
        voice_config: data.voice_config,
        start_command: data.start_command,
        health_endpoint: data.health_endpoint,
        agent_url: data.agent_url,
        agent_session_id: data.agent_session_id,
      });
    });
  } finally {
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

const queueRuntime = new PerUserQueueRuntime({
  connection,
  workerConnection,
  machineId,
  totalConcurrency,
  workerMetrics,
  processRun,
});

async function start() {
  // Start persistent HTTP server for Bland webhook callbacks.
  // Must listen at boot so Fly.io's proxy routes traffic to this machine.
  const webhookPort = parseInt(process.env["RUNNER_LISTEN_PORT"] ?? "0", 10);
  const webhookHost = process.env["RUNNER_PUBLIC_HOST"] ?? "";
  if (webhookPort && webhookHost) {
    await WebhookServer.startPersistentServer({
      publicHost: webhookHost,
      port: webhookPort,
      publicPort: null, // Behind Fly reverse proxy (443 → 8443)
    });
  }

  await queueRuntime.start();
  console.log(
    `Vent Worker started (machine: ${machineId}, total concurrency: ${totalConcurrency})`,
  );
}

start().catch((err) => {
  console.error("Failed to start worker:", err);
  process.exit(1);
});

// Track shutdown so we don't fire twice and so the heartbeat in processRun
// can keep extending the BullMQ lock for in-flight calls during drain.
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

  try {
    // queueRuntime.close() pauses every Worker (no new jobs accepted) and
    // calls Worker.close() which gracefully waits for active jobs to
    // complete before resolving. Combined with the heartbeat in processRun
    // and Fly's kill_timeout=15m, in-flight voice calls finish naturally
    // instead of getting hard-killed mid-conversation on every deploy.
    await queueRuntime.close();
  } catch (err) {
    console.error(`[shutdown] queueRuntime.close failed:`, (err as Error).message);
  } finally {
    clearInterval(progressTimer);
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
