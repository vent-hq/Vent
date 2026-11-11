import fp from "fastify-plugin";
import { createDb, type Database } from "@vent/db";
import { envPositiveInt, requireEnv } from "@vent/shared";

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
  }
}

export const dbPlugin = fp(async (app) => {
  const connectionString = requireEnv("DATABASE_URL");
  // Default 30 = comfortable headroom for SSE replays + cleanup interval +
  // /internal/* callback transactions. Override with API_DB_POOL_MAX if you
  // run a fatter API box.
  const max = envPositiveInt("API_DB_POOL_MAX", 30);
  const db = createDb(connectionString, {
    max,
    idleTimeoutSeconds: 30,
    maxLifetimeSeconds: 3600,
  });
  app.decorate("db", db);
});
