import http from "node:http";
import { Queue } from "bullmq";
import type IORedis from "ioredis";
import { RUN_QUEUE_NAME } from "@vent/shared";
import {
  Counter,
  Gauge,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

export interface WorkerMetrics {
  onJobStart(): void;
  onJobFinish(): void;
  /** Startup finished: /health starts returning 200. */
  markReady(): void;
  close(): Promise<void>;
}

interface WorkerMetricsOptions {
  connection: IORedis;
  metricsPort: number;
  totalConcurrency: number;
}

const SCRAPE_INTERVAL_MS = 5_000;

export function createWorkerMetrics(opts: WorkerMetricsOptions): WorkerMetrics {
  const { connection, metricsPort, totalConcurrency } = opts;
  const register = new Registry();
  collectDefaultMetrics({ register });

  const queue = new Queue(RUN_QUEUE_NAME, { connection });
  // Reports this machine's own startup, not Postgres or Redis health: both are
  // shared by every machine, so a blip there would fail every check at once.
  let ready = false;
  let scrapeTimer: ReturnType<typeof setInterval> | null = null;
  let scrapePromise: Promise<void> | null = null;

  const configuredTotalConcurrency = new Gauge({
    name: "vent_worker_configured_total_concurrency",
    help: "Configured total active run budget for this worker machine.",
    registers: [register],
  });
  configuredTotalConcurrency.set(totalConcurrency);

  const localRunningJobs = new Gauge({
    name: "vent_worker_local_running_jobs",
    help: "Runs currently executing on this worker process.",
    registers: [register],
  });

  const queueWaitingJobs = new Gauge({
    name: "vent_worker_queue_waiting_jobs",
    help: "Global waiting jobs. Every worker reports the same total; use max(), not sum(), in Prometheus queries.",
    registers: [register],
  });

  const queueActiveJobs = new Gauge({
    name: "vent_worker_queue_active_jobs",
    help: "Global active jobs. Every worker reports the same total; use max(), not sum(), in Prometheus queries.",
    registers: [register],
  });

  const queueDelayedJobs = new Gauge({
    name: "vent_worker_queue_delayed_jobs",
    help: "Global delayed jobs. Every worker reports the same total; use max(), not sum(), in Prometheus queries.",
    registers: [register],
  });

  const queueBacklogJobs = new Gauge({
    name: "vent_worker_queue_backlog_jobs",
    help: "Global backlog (wait + prioritized + waiting-children). Every worker reports the same total; use max(), not sum(), in Prometheus queries.",
    registers: [register],
  });

  const finishedJobs = new Counter({
    name: "vent_worker_jobs_finished_total",
    help: "Runs finished on this worker process.",
    registers: [register],
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(ready ? 200 : 503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(ready ? "ok" : "starting");
      return;
    }

    if (url.pathname !== "/metrics") {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      await refreshQueueMetrics();
      res.writeHead(200, { "Content-Type": register.contentType });
      res.end(await register.metrics());
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`metrics error: ${(err as Error).message}`);
    }
  });

  server.listen(metricsPort, "0.0.0.0");

  async function refreshQueueMetrics(): Promise<void> {
    if (scrapePromise) {
      await scrapePromise;
      return;
    }

    scrapePromise = (async () => {
      const counts = await queue.getJobCounts(
        "wait",
        "active",
        "delayed",
        "prioritized",
        "waiting-children",
      );
      queueWaitingJobs.set(counts.wait ?? 0);
      queueActiveJobs.set(counts.active ?? 0);
      queueDelayedJobs.set(counts.delayed ?? 0);
      queueBacklogJobs.set((counts.wait ?? 0) + (counts.prioritized ?? 0) + (counts["waiting-children"] ?? 0));
    })();

    try {
      await scrapePromise;
    } finally {
      scrapePromise = null;
    }
  }

  void refreshQueueMetrics();
  scrapeTimer = setInterval(() => {
    void refreshQueueMetrics().catch((err) => {
      console.warn(`[metrics] Failed to refresh queue metrics: ${(err as Error).message}`);
    });
  }, SCRAPE_INTERVAL_MS);

  return {
    onJobStart() {
      localRunningJobs.inc();
    },
    onJobFinish() {
      localRunningJobs.dec();
      finishedJobs.inc();
    },
    markReady() {
      ready = true;
    },
    async close() {
      if (scrapeTimer) clearInterval(scrapeTimer);
      await queue.close().catch(() => {});
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    },
  };
}
