import fp from "fastify-plugin";
import { createDb, type Database } from "@vent/db";
import { requireEnv } from "@vent/shared";

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
  }
}

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export const dbPlugin = fp(async (app) => {
  const connectionString = requireEnv("DATABASE_URL");
  // Default 30 = comfortable headroom for SSE replays + cleanup interval +
  // /internal/* callback transactions. Override with API_DB_POOL_MAX if you
  // run a fatter API box.
  const max = parsePositiveInt("API_DB_POOL_MAX", 30);
  const db = createDb(connectionString, {
    max,
    idleTimeoutSeconds: 30,
    maxLifetimeSeconds: 3600,
  });
  app.decorate("db", db);
});
