import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { before, mock, test } from "node:test";
import type IORedis from "ioredis";
import { RUN_QUEUE_NAME } from "@vent/shared";

class FakeQueueEvents extends EventEmitter {
  static instances: FakeQueueEvents[] = [];
  closed = false;
  constructor(readonly queue: string, readonly options: Record<string, unknown>) {
    super();
    FakeQueueEvents.instances.push(this);
  }
  async waitUntilReady() {}
  async close() { this.closed = true; }
}

class FakeChecker extends EventEmitter {
  static instances: FakeChecker[] = [];
  started = false;
  closed = false;
  constructor(readonly queue: string, readonly processor: unknown, readonly options: Record<string, unknown>) {
    super();
    FakeChecker.instances.push(this);
  }
  async waitUntilReady() {}
  async startStalledCheckTimer() { this.started = true; }
  async close() { this.closed = true; }
}

mock.module("bullmq", { namedExports: { QueueEvents: FakeQueueEvents, Worker: FakeChecker } });
let RunQueueMonitor: typeof import("../../src/lib/run-queue-monitor.js").RunQueueMonitor;
before(async () => { ({ RunQueueMonitor } = await import("../../src/lib/run-queue-monitor.js")); });

function connection() {
  return { redis: {} as unknown as IORedis };
}
const settled = () => new Promise<void>(resolve => setImmediate(resolve));

test("API monitors the run queue without fetching or executing its calls", async () => {
  const { redis } = connection();
  const monitor = new RunQueueMonitor(redis, async () => {}, () => {});
  try {
    await monitor.start();
    const checker = FakeChecker.instances.at(-1)!;
    assert.equal(checker.queue, RUN_QUEUE_NAME);
    assert.equal(FakeQueueEvents.instances.at(-1)!.queue, RUN_QUEUE_NAME);
    assert.equal(checker.processor, null);
    assert.equal(checker.options.autorun, false);
    assert.equal(checker.options.stalledInterval, 5_000);
    assert.equal(checker.options.maxStalledCount, 0);
    assert.equal(checker.started, true);
    assert.equal(FakeQueueEvents.instances.at(-1)!.options.lastEventId, "0-0");
  } finally { await monitor.close(); }
});

test("a stalled event ends the run even when no call worker survives", async () => {
  const { redis } = connection();
  const failures: { id: string; reason: string }[] = [];
  const monitor = new RunQueueMonitor(redis, async (id, reason) => { failures.push({ id, reason }); }, () => {});
  try {
    await monitor.start();
    FakeQueueEvents.instances.at(-1)!.emit("stalled", { jobId: "lost-run" });
    await settled();
    assert.deepEqual(failures, [{
      id: "lost-run",
      reason: "Worker stopped renewing the call lock (worker crashed or lost its Redis connection)",
    }]);
  } finally { await monitor.close(); }
});

test("failed events preserve the queue's failure reason", async () => {
  const { redis } = connection();
  const failures: string[] = [];
  const monitor = new RunQueueMonitor(redis, async (id, reason) => { failures.push(`${id}: ${reason}`); }, () => {});
  try {
    await monitor.start();
    FakeQueueEvents.instances.at(-1)!.emit("failed", { jobId: "failed-run", failedReason: "worker terminated" });
    await settled();
    assert.deepEqual(failures, ["failed-run: worker terminated"]);
  } finally { await monitor.close(); }
});

test("a transient database failure retries the event without another queue event", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { redis } = connection();
  let attempts = 0;
  const errors: unknown[] = [];
  const monitor = new RunQueueMonitor(redis, async () => {
    if (++attempts === 1) throw new Error("database temporarily unavailable");
  }, error => errors.push(error));
  try {
    await monitor.start();
    const events = FakeQueueEvents.instances.at(-1)!;
    events.emit("stalled", { jobId: "retry-run" });
    events.emit("failed", { jobId: "retry-run", failedReason: "duplicate event" });
    await settled();
    assert.equal(attempts, 1);
    assert.equal(errors.length, 1);
    t.mock.timers.tick(5_000);
    await settled();
    assert.equal(attempts, 2);
  } finally { await monitor.close(); }
});

test("shutdown closes the checkers and ignores further events", async () => {
  const { redis } = connection();
  let failures = 0;
  const monitor = new RunQueueMonitor(redis, async () => { failures++; }, () => {});
  await monitor.start();
  const events = FakeQueueEvents.instances.at(-1)!;
  const checker = FakeChecker.instances.at(-1)!;
  await monitor.close();
  events.emit("stalled", { jobId: "late-run" });
  await settled();
  assert.equal(events.closed, true);
  assert.equal(checker.closed, true);
  assert.equal(failures, 0);
});
