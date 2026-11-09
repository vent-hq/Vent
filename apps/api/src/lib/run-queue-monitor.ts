import { QueueEvents, Worker } from "bullmq";
import type IORedis from "ioredis";
import { RUN_JOB_STALLED_INTERVAL_MS, RUN_QUEUE_NAME } from "@vent/shared";

const LOST_LOCK_MESSAGE = "Worker stopped renewing the call lock (worker crashed or lost its Redis connection)";

interface PendingFailure {
  retry?: ReturnType<typeof setTimeout>;
  work?: Promise<void>;
}

// Ends runs whose job failed or lost its lock, even when no call worker survives.
export class RunQueueMonitor {
  private events: QueueEvents | null = null;
  private checker: Worker | null = null;
  private readonly pending = new Map<string, PendingFailure>();
  private closed = false;

  constructor(
    private readonly connection: IORedis,
    private readonly failRun: (runId: string, reason: string) => Promise<void>,
    private readonly reportError: (error: unknown) => void,
  ) {}

  async start(): Promise<void> {
    // Replay missed failures; finalizeRun ignores runs that already ended.
    const events = new QueueEvents(RUN_QUEUE_NAME, {
      connection: this.connection,
      lastEventId: "0-0",
    });
    // Runs no jobs: only checks for jobs whose worker stopped renewing the lock.
    const checker = new Worker(RUN_QUEUE_NAME, null, {
      connection: this.connection,
      autorun: false,
      stalledInterval: RUN_JOB_STALLED_INTERVAL_MS,
      maxStalledCount: 0,
    });
    this.events = events;
    this.checker = checker;
    events.on("error", this.reportError);
    checker.on("error", this.reportError);
    events.on("failed", ({ jobId, failedReason }) => this.endRun(jobId, failedReason));
    // BullMQ may defer 'failed' until another worker fetches the stalled job.
    events.on("stalled", ({ jobId }) => this.endRun(jobId, LOST_LOCK_MESSAGE));

    await Promise.all([events.waitUntilReady(), checker.waitUntilReady()]);
    if (!this.closed) await checker.startStalledCheckTimer();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.pending.values()) {
      if (entry.retry) clearTimeout(entry.retry);
    }
    await Promise.allSettled([this.events?.close(), this.checker?.close()]);
    await Promise.allSettled([...this.pending.values()].map(entry => entry.work));
    this.pending.clear();
  }

  private endRun(runId: string, reason: string): void {
    if (this.closed || this.pending.has(runId)) return;
    const entry: PendingFailure = {};
    this.pending.set(runId, entry);
    const attempt = () => {
      entry.work = this.failRun(runId, reason).then(() => {
        this.pending.delete(runId);
      }).catch(error => {
        this.reportError(error);
        // QueueEvents won't retry a rejected listener for us.
        if (!this.closed) entry.retry = setTimeout(attempt, RUN_JOB_STALLED_INTERVAL_MS);
      });
    };
    attempt();
  }
}
