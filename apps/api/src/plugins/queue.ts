import fp from "fastify-plugin";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import {
  RUN_QUEUE_ACTIVITY_CHANNEL,
  RUN_QUEUE_ACTIVITY_KEY_PREFIX,
  RUN_QUEUE_ACTIVITY_TTL_SECONDS,
  RUN_QUEUE_NEW_CHANNEL,
  RUN_QUEUE_PREFIX,
  RUN_QUEUE_REGISTRY_SET,
  requireEnv,
} from "@vent/shared";

declare module "fastify" {
  interface FastifyInstance {
    getRunQueue: (userId: string) => Queue;
    getRunQueueName: (userId: string) => string;
    markRunQueueActive: (userId: string) => Promise<void>;
    redis: IORedis;
  }
}

export const queuePlugin = fp(async (app) => {
  const redisUrl = requireEnv("REDIS_URL");
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

  app.decorate("redis", connection);

  const queues = new Map<string, Queue>();

  app.decorate("getRunQueueName", (userId: string) => `${RUN_QUEUE_PREFIX}${userId}`);

  app.decorate("markRunQueueActive", async (userId: string) => {
    const queueName = app.getRunQueueName(userId);
    await connection
      .multi()
      .sadd(RUN_QUEUE_REGISTRY_SET, queueName)
      .set(`${RUN_QUEUE_ACTIVITY_KEY_PREFIX}${queueName}`, "1", "EX", RUN_QUEUE_ACTIVITY_TTL_SECONDS)
      .publish(RUN_QUEUE_ACTIVITY_CHANNEL, queueName)
      .exec();
  });

  app.decorate("getRunQueue", (userId: string) => {
    const name = app.getRunQueueName(userId);
    if (!queues.has(name)) {
      const q = new Queue(name, {
        connection,
        defaultJobOptions: {
          // Voice calls are non-idempotent (each execution = a real billed phone call).
          // Never let BullMQ auto-retry on a thrown error.
          attempts: 1,
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 86_400, count: 5000 },
        },
      });
      queues.set(name, q);
      // Notify worker of new queue via Redis Set + pub/sub
      void connection.sadd(RUN_QUEUE_REGISTRY_SET, name);
      void connection.publish(RUN_QUEUE_NEW_CHANNEL, name);
    }
    return queues.get(name)!;
  });

  app.addHook("onClose", async () => {
    for (const q of queues.values()) {
      await q.close();
    }
    connection.disconnect();
  });
});
