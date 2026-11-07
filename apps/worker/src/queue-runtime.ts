import { createHash } from "node:crypto";
import { Queue, Worker, type Job } from "bullmq";
import type IORedis from "ioredis";
import {
  RUN_QUEUE_ACTIVITY_CHANNEL,
  RUN_QUEUE_ACTIVITY_KEY_PREFIX,
  RUN_QUEUE_ACTIVITY_TTL_SECONDS,
  RUN_QUEUE_NEW_CHANNEL,
  RUN_QUEUE_REGISTRY_SET,
  WORKER_PRESENCE_KEY_PREFIX,
  WORKER_PRESENCE_SET,
  WORKER_PRESENCE_TTL_SECONDS,
} from "@vent/shared";
import type { WorkerMetrics } from "./metrics.js";

const RECONCILE_INTERVAL_MS = 5_000;
const HOT_QUEUE_SCAN_INTERVAL_MS = 15_000;

// BullMQ stalled-replay protection. DEFAULT_TIMEOUT_MS in the runner is
// 600_000 (10 min); lock comfortably exceeds it. BullMQ's LockManager
// auto-renews every lockDuration/2 (~7.5 min) while the job is active —
// no manual heartbeat needed.
export const LOCK_DURATION_MS = 900_000;

export interface RunJobData {
  run_id: string;
  user_id: string;
  adapter?: string;
  call_spec?: Record<string, unknown>;
  voice_config?: Record<string, unknown>;
  start_command?: string;
  health_endpoint?: string;
  agent_url?: string;
  agent_session_id?: string;
}

interface QueueRuntimeOptions {
  /** Shared IORedis for non-blocking ops (Queue, smembers, scan, multi). */
  connection: IORedis;
  /** Dedicated IORedis for BullMQ Workers (used for blocking commands).
   *  Required because mixing Worker blocking BLPOP with non-blocking ops
   *  on the same connection deadlocks under load. */
  workerConnection: IORedis;
  machineId: string;
  totalConcurrency: number;
  workerMetrics: WorkerMetrics;
  processRun: (
    queueName: string,
    data: RunJobData,
    job: Job<RunJobData>,
    token: string | undefined,
  ) => Promise<void>;
}

interface QueueState {
  name: string;
  queue: Queue;
  worker: Worker | null;
  stopPromise: Promise<void> | null;
  demand: number;
  lastActivityAt: number;
}

export class PerUserQueueRuntime {
  private readonly connection: IORedis;
  private readonly workerConnection: IORedis;
  private readonly machineId: string;
  private readonly totalConcurrency: number;
  private readonly workerMetrics: WorkerMetrics;
  private readonly processRun: (
    queueName: string,
    data: RunJobData,
    job: Job<RunJobData>,
    token: string | undefined,
  ) => Promise<void>;

  private readonly queueStates = new Map<string, QueueState>();
  private readonly hotQueues = new Map<string, number>();

  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private subscriber: IORedis | null = null;
  private lastHotQueueScanAt = 0;
  private closed = false;
  private reconciling = false;
  private reconcileQueued = false;

  constructor(opts: QueueRuntimeOptions) {
    this.connection = opts.connection;
    this.workerConnection = opts.workerConnection;
    this.machineId = opts.machineId;
    this.totalConcurrency = opts.totalConcurrency;
    this.workerMetrics = opts.workerMetrics;
    this.processRun = opts.processRun;
  }

  async start(): Promise<void> {
    await this.writeHeartbeat();
    await this.refreshHotQueuesFromRedis();

    if (this.hotQueues.size === 0) {
      const bootstrapQueues = await this.connection.smembers(RUN_QUEUE_REGISTRY_SET);
      for (const queueName of bootstrapQueues) {
        this.hotQueues.set(queueName, 0);
      }
    }

    this.subscriber = this.connection.duplicate();
    await this.subscriber.subscribe(RUN_QUEUE_NEW_CHANNEL, RUN_QUEUE_ACTIVITY_CHANNEL);
    this.subscriber.on("message", (channel, message) => {
      if (channel !== RUN_QUEUE_NEW_CHANNEL && channel !== RUN_QUEUE_ACTIVITY_CHANNEL) {
        return;
      }
      this.hotQueues.set(message, Date.now());
      this.scheduleReconcile(`pubsub:${channel}`);
    });

    this.reconcileTimer = setInterval(() => {
      this.scheduleReconcile("interval");
    }, RECONCILE_INTERVAL_MS);

    this.scheduleReconcile("start");
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    if (this.subscriber) {
      try {
        await this.subscriber.unsubscribe(RUN_QUEUE_NEW_CHANNEL, RUN_QUEUE_ACTIVITY_CHANNEL);
      } catch {
        // ignore unsubscribe failures during shutdown
      }
      this.subscriber.disconnect();
      this.subscriber = null;
    }

    const stopPromises: Promise<void>[] = [];
    for (const state of this.queueStates.values()) {
      const stopPromise = this.stopWorker(state);
      if (stopPromise) {
        stopPromises.push(stopPromise);
      }
    }
    await Promise.allSettled(stopPromises);

    const closeQueues = Array.from(this.queueStates.values(), async (state) => {
      await state.queue.close().catch(() => {});
      this.workerMetrics.forgetQueue(state.name);
    });
    await Promise.allSettled(closeQueues);
    this.queueStates.clear();
    this.hotQueues.clear();

    await this.connection
      .multi()
      .del(this.workerPresenceKey(this.machineId))
      .srem(WORKER_PRESENCE_SET, this.machineId)
      .exec()
      .catch(() => {});
  }

  private scheduleReconcile(reason: string): void {
    if (this.closed) {
      return;
    }

    if (this.reconciling) {
      this.reconcileQueued = true;
      return;
    }

    void this.reconcile(reason);
  }

  private async reconcile(reason: string): Promise<void> {
    if (this.closed || this.reconciling) {
      this.reconcileQueued = true;
      return;
    }

    this.reconciling = true;
    try {
      await this.runReconcile(reason);
    } catch (error) {
      console.error(`[queue-runtime] Reconcile failed (${reason}):`, (error as Error).message);
    } finally {
      this.reconciling = false;
      if (this.reconcileQueued && !this.closed) {
        this.reconcileQueued = false;
        this.scheduleReconcile("queued");
      }
    }
  }

  private async runReconcile(_reason: string): Promise<void> {
    await this.writeHeartbeat();
    await this.refreshHotQueuesFromRedisIfDue();

    const activeMachineIds = await this.getActiveMachineIds();
    const candidateQueueNames = new Set<string>([
      ...this.hotQueues.keys(),
      ...this.queueStates.keys(),
    ]);

    const ownedDemandingQueues: QueueState[] = [];
    const now = Date.now();

    for (const queueName of candidateQueueNames) {
      const state = this.getOrCreateQueueState(queueName);
      const counts = await state.queue.getJobCounts(
        "wait",
        "active",
        "prioritized",
        "waiting-children",
      );
      const demand =
        (counts.wait ?? 0) +
        (counts.active ?? 0) +
        (counts.prioritized ?? 0) +
        (counts["waiting-children"] ?? 0);

      state.demand = demand;
      if (demand > 0) {
        state.lastActivityAt = now;
        this.hotQueues.set(queueName, now);
        await this.refreshQueueActivity(queueName);
      }

      const ownerMachineId = selectQueueOwner(queueName, activeMachineIds);
      if (ownerMachineId === this.machineId && demand > 0) {
        ownedDemandingQueues.push(state);
        continue;
      }

      this.stopWorker(state);
    }

    const targetConcurrency = allocateQueueConcurrency(
      ownedDemandingQueues,
      this.totalConcurrency,
    );

    for (const state of ownedDemandingQueues) {
      const target = targetConcurrency.get(state.name) ?? 0;
      await this.ensureWorker(state, target);
    }

    for (const [queueName, state] of this.queueStates) {
      const target = targetConcurrency.get(queueName) ?? 0;
      if (target === 0) {
        this.stopWorker(state);
      }
    }

    this.pruneIdleQueues(now);
    this.workerMetrics.setHotQueues(this.hotQueues.size);
    this.workerMetrics.setOwnedQueues(ownedDemandingQueues.length);
    this.workerMetrics.setLocalQueueWorkers(
      Array.from(this.queueStates.values()).filter((state) => state.worker !== null).length,
    );
  }

  private getOrCreateQueueState(queueName: string): QueueState {
    const existing = this.queueStates.get(queueName);
    if (existing) {
      return existing;
    }

    const state: QueueState = {
      name: queueName,
      queue: new Queue(queueName, { connection: this.connection }),
      worker: null,
      stopPromise: null,
      demand: 0,
      lastActivityAt: 0,
    };

    this.queueStates.set(queueName, state);
    this.workerMetrics.observeQueue(queueName);
    return state;
  }

  private async ensureWorker(state: QueueState, target: number): Promise<void> {
    if (target <= 0) {
      this.stopWorker(state);
      return;
    }

    if (state.stopPromise) {
      return;
    }

    if (!state.worker) {
      state.worker = this.createWorker(state.name, target);
      return;
    }

    if (state.worker.concurrency !== target) {
      state.worker.concurrency = target;
      console.log(`[queue-runtime] Updated ${state.name} concurrency -> ${target}`);
    }
  }

  private createWorker(queueName: string, concurrency: number): Worker {
    const worker = new Worker<RunJobData>(
      queueName,
      async (job, token) => {
        await this.processRun(queueName, job.data, job, token);
      },
      {
        // Workers MUST use a dedicated connection so BullMQ's blocking BLPOP
        // doesn't contend with the non-blocking ops we issue on `connection`.
        connection: this.workerConnection,
        concurrency,
        lockDuration: LOCK_DURATION_MS,
        stalledInterval: 30_000,
        // Voice calls are non-idempotent. If a lock lapses, send the job
        // straight to `failed` rather than re-delivering it (which would
        // place a second real phone call). Heartbeat in processRun keeps
        // the lock alive for legitimately long-running jobs.
        maxStalledCount: 0,
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86_400, count: 5000 },
      },
    );

    worker.on("completed", (job) => {
      console.log(`[${queueName}] Run ${job.id} completed`);
      this.scheduleReconcile(`completed:${queueName}`);
    });

    worker.on("failed", (job, err) => {
      console.error(`[${queueName}] Run ${job?.id} failed:`, err.message);
      this.scheduleReconcile(`failed:${queueName}`);
    });

    console.log(`[queue-runtime] Worker owns ${queueName} (local concurrency: ${concurrency})`);
    return worker;
  }

  private stopWorker(state: QueueState): Promise<void> | null {
    if (!state.worker || state.stopPromise) {
      return state.stopPromise;
    }

    const worker = state.worker;
    state.worker = null;
    state.stopPromise = (async () => {
      try {
        await worker.pause();
      } catch {
        // ignore pause failures during handoff
      }
      try {
        await worker.close();
      } catch {
        // ignore close failures during handoff
      } finally {
        state.stopPromise = null;
        console.log(`[queue-runtime] Released ${state.name}`);
        this.scheduleReconcile(`released:${state.name}`);
      }
    })();

    return state.stopPromise;
  }

  private pruneIdleQueues(now: number): void {
    const hotCutoff = now - RUN_QUEUE_ACTIVITY_TTL_SECONDS * 1000;
    for (const [queueName, state] of this.queueStates) {
      const lastSeen = this.hotQueues.get(queueName) ?? state.lastActivityAt;
      if (lastSeen > 0 && lastSeen < hotCutoff && state.demand === 0 && !state.worker && !state.stopPromise) {
        this.hotQueues.delete(queueName);
      }

      if (state.demand === 0 && !state.worker && !state.stopPromise && !this.hotQueues.has(queueName)) {
        void state.queue.close().catch(() => {});
        this.workerMetrics.forgetQueue(queueName);
        this.queueStates.delete(queueName);
      }
    }
  }

  private async refreshHotQueuesFromRedisIfDue(): Promise<void> {
    if (Date.now() - this.lastHotQueueScanAt < HOT_QUEUE_SCAN_INTERVAL_MS) {
      return;
    }
    await this.refreshHotQueuesFromRedis();
  }

  private async refreshHotQueuesFromRedis(): Promise<void> {
    this.lastHotQueueScanAt = Date.now();
    let cursor = "0";

    do {
      const [nextCursor, keys] = await this.connection.scan(
        cursor,
        "MATCH",
        `${RUN_QUEUE_ACTIVITY_KEY_PREFIX}*`,
        "COUNT",
        "200",
      );
      cursor = nextCursor;
      for (const key of keys) {
        const queueName = key.slice(RUN_QUEUE_ACTIVITY_KEY_PREFIX.length);
        this.hotQueues.set(queueName, Date.now());
      }
    } while (cursor !== "0");
  }

  private async refreshQueueActivity(queueName: string): Promise<void> {
    await this.connection
      .set(queueActivityKey(queueName), "1", "EX", RUN_QUEUE_ACTIVITY_TTL_SECONDS)
      .catch(() => {});
  }

  private async writeHeartbeat(): Promise<void> {
    await this.connection
      .multi()
      .set(this.workerPresenceKey(this.machineId), "1", "EX", WORKER_PRESENCE_TTL_SECONDS)
      .sadd(WORKER_PRESENCE_SET, this.machineId)
      .exec();
  }

  private async getActiveMachineIds(): Promise<string[]> {
    const knownMachineIds = await this.connection.smembers(WORKER_PRESENCE_SET);
    if (!knownMachineIds.includes(this.machineId)) {
      knownMachineIds.push(this.machineId);
    }

    if (knownMachineIds.length === 0) {
      return [this.machineId];
    }

    const pipeline = this.connection.pipeline();
    for (const machineId of knownMachineIds) {
      pipeline.exists(this.workerPresenceKey(machineId));
    }

    const results = await pipeline.exec();
    const activeMachineIds: string[] = [];
    const missingMachineIds: string[] = [];

    knownMachineIds.forEach((machineId, index) => {
      const exists = Number(results?.[index]?.[1] ?? 0);
      if (exists === 1 || machineId === this.machineId) {
        activeMachineIds.push(machineId);
      } else {
        missingMachineIds.push(machineId);
      }
    });

    if (missingMachineIds.length > 0) {
      await this.connection.srem(WORKER_PRESENCE_SET, ...missingMachineIds).catch(() => {});
    }

    if (!activeMachineIds.includes(this.machineId)) {
      activeMachineIds.push(this.machineId);
    }

    activeMachineIds.sort();
    return activeMachineIds;
  }

  private workerPresenceKey(machineId: string): string {
    return `${WORKER_PRESENCE_KEY_PREFIX}${machineId}`;
  }
}

function queueActivityKey(queueName: string): string {
  return `${RUN_QUEUE_ACTIVITY_KEY_PREFIX}${queueName}`;
}

function selectQueueOwner(queueName: string, machineIds: string[]): string {
  if (machineIds.length === 0) {
    throw new Error("selectQueueOwner requires at least one machine id");
  }

  let owner = machineIds[0];
  let ownerScore = hashScore(queueName, owner);

  for (let index = 1; index < machineIds.length; index++) {
    const candidate = machineIds[index];
    const candidateScore = hashScore(queueName, candidate);
    if (candidateScore > ownerScore) {
      owner = candidate;
      ownerScore = candidateScore;
    }
  }

  return owner;
}

function hashScore(queueName: string, machineId: string): bigint {
  const digest = createHash("sha256").update(queueName).update("\0").update(machineId).digest();
  return digest.readBigUInt64BE(0);
}

function allocateQueueConcurrency(
  queueStates: QueueState[],
  totalConcurrency: number,
): Map<string, number> {
  const targets = new Map<string, number>();
  if (queueStates.length === 0 || totalConcurrency <= 0) {
    return targets;
  }

  // Fair-share: distribute total budget evenly, then give remainder to highest-demand queues.
  const base = Math.floor(totalConcurrency / queueStates.length);
  let remainder = totalConcurrency - base * queueStates.length;

  const orderedStates = [...queueStates].sort((a, b) => {
    if (b.demand !== a.demand) {
      return b.demand - a.demand;
    }
    return a.name.localeCompare(b.name);
  });

  for (const state of orderedStates) {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    targets.set(state.name, base + extra);
  }

  return targets;
}
