import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { createRateLimitRedis } from "../lib/rate-limit-redis.js";
import { getClientIp } from "../lib/client-ip.js";

/** Rate-limit key for a request with no proven user: the connecting IP. */
export function ipKey(request: FastifyRequest): string {
  return `ip:${getClientIp(request)}`;
}

export const rateLimitPlugin = fp(async (app) => {
  const redis = createRateLimitRedis(app);
  await app.register(rateLimit, {
    global: false,
    redis,
    nameSpace: "vent:rl:",
    keyGenerator: ipKey,
    skipOnError: true,
  });
});
