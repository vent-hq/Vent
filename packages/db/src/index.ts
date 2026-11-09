import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export { schema };
export type { runs, scenarioResults, accessTokens, RunTestSpec } from "./schema.js";

export interface CreateDbOptions {
  /** Max pool connections. postgres-js default is 10 — too low for the worker
   *  under WORKER_TOTAL_CONCURRENCY > 10 and for the API under SSE + cleanup
   *  + callback transaction load. Callers should size this from their env. */
  max?: number;
  /** Seconds before an idle connection is closed (postgres-js: 0 = never).
   *  Setting this prevents long-lived stale connections to a restarted DB. */
  idleTimeoutSeconds?: number;
  /** Seconds before any connection is rotated, even if active (default: never).
   *  Caps connection age so a slow leak self-heals on rotation. */
  maxLifetimeSeconds?: number;
}

export function createDb(connectionString: string, opts: CreateDbOptions = {}) {
  const client = postgres(connectionString, {
    max: opts.max,
    idle_timeout: opts.idleTimeoutSeconds,
    max_lifetime: opts.maxLifetimeSeconds,
  });
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;
