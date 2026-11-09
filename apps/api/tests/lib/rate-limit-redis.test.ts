import assert from "node:assert/strict";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import { test } from "node:test";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import Redis, { AbstractConnector } from "ioredis";
import { createRateLimitRedis } from "../../src/lib/rate-limit-redis.js";

class BlackholeStream extends Duplex {
  connecting = false;
  writes = 0;
  _read() {}
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.writes++;
    done();
  }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
}

class BlackholeConnector extends AbstractConnector {
  static streams: BlackholeStream[] = [];
  constructor() { super(0); }
  async connect() {
    const stream = new BlackholeStream();
    BlackholeConnector.streams.push(stream);
    this.stream = stream as unknown as Socket;
    return this.stream;
  }
  disconnect() { this.stream?.destroy(); }
}

class UnavailableConnector extends AbstractConnector {
  constructor() { super(0); }
  async connect(): Promise<Socket> { throw new Error("Redis unavailable"); }
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Rate-limit request hung")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(Connector: typeof BlackholeConnector | typeof UnavailableConnector) {
  const app = Fastify();
  const queueRedis = new Redis({
    Connector,
    lazyConnect: true,
    enableReadyCheck: false,
    disableClientInfo: true,
    maxRetriesPerRequest: null,
    retryStrategy: () => null,
  });
  app.decorate("redis", queueRedis);
  const originalOptions = { ...queueRedis.options };
  const limiterRedis = createRateLimitRedis(app);
  await app.register(rateLimit, { redis: limiterRedis, max: 50, timeWindow: "1 minute", skipOnError: true });
  app.get("/normal", async () => ({ ok: true }));
  await app.ready();
  return { app, queueRedis, limiterRedis, originalOptions };
}

test("a connected Redis that never replies cannot hang an HTTP rate-limit check", async () => {
  const { app, queueRedis, limiterRedis, originalOptions } = await fixture(BlackholeConnector);
  try {
    await limiterRedis.connect();
    const transport = BlackholeConnector.streams.at(-1)!;
    const started = performance.now();
    const response = await within(app.inject({ url: "/normal" }), 2_500);
    const elapsed = performance.now() - started;
    assert.equal(response.statusCode, 200);
    assert.ok(transport.writes > 0, "the limiter actually sent a Redis command");
    assert.ok(elapsed >= 800 && elapsed < 2_500, `command timeout took ${elapsed}ms`);
    assert.notEqual(limiterRedis, queueRedis);
    assert.deepEqual(queueRedis.options, originalOptions);
    assert.equal(queueRedis.status, "wait");
    assert.equal(limiterRedis.options.commandTimeout, 1_000);
    assert.equal(limiterRedis.options.enableOfflineQueue, false);
    assert.equal(limiterRedis.options.autoResendUnfulfilledCommands, false);
    await app.close();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(transport.destroyed, true);
    assert.equal(limiterRedis.status, "end");
    assert.equal(queueRedis.status, "wait");
  } finally {
    limiterRedis.disconnect();
    queueRedis.disconnect();
    await app.close();
  }
});

test("an unavailable Redis lets HTTP requests proceed without queuing commands forever", async () => {
  const { app, queueRedis, limiterRedis, originalOptions } = await fixture(UnavailableConnector);
  try {
    await assert.rejects(limiterRedis.connect(), /Redis unavailable/);
    const response = await within(app.inject({ url: "/normal" }), 500);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(queueRedis.options, originalOptions);
    assert.equal(queueRedis.status, "wait");
  } finally {
    limiterRedis.disconnect();
    queueRedis.disconnect();
    await app.close();
  }
});
