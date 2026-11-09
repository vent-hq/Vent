import type { FastifyInstance } from "fastify";

export function createRateLimitRedis(app: FastifyInstance) {
  const redis = app.redis.duplicate({
    connectTimeout: 1_000,
    commandTimeout: 1_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
  });
  redis.on("error", error => app.log.warn({ err: error }, "Rate-limit Redis unavailable"));
  app.addHook("onClose", async () => { redis.disconnect(); });
  return redis;
}
