import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const runStatusEnum = pgEnum("run_status", [
  "queued",
  "running",
  "pass",
  "fail",
  "cancelled",
]);


export const agentSessionStatusEnum = pgEnum("agent_session_status", ["connecting", "active", "closed"]);

export const scenarioStatusEnum = pgEnum("scenario_status", ["completed", "error"]);

/** What a run is asked to do, saved at submit. The worker job is built from it,
 *  so a run whose job was lost can be queued again (apps/api enqueue-run.ts). */
export interface RunTestSpec {
  call: Record<string, unknown> | null;
  adapter: string;
  voice_config: { adapter: string };
  start_command: string | null;
  health_endpoint: string | null;
  agent_url: string | null;
}

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    access_token_id: uuid("access_token_id")
      .notNull()
      .references(() => accessTokens.id),
    user_id: text("user_id").notNull(),
    status: runStatusEnum("status").notNull().default("queued"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    started_at: timestamp("started_at", { withTimezone: true }),
    finished_at: timestamp("finished_at", { withTimezone: true }),
    duration_ms: integer("duration_ms"),
    aggregate_json: jsonb("aggregate_json"),
    test_spec_json: jsonb("test_spec_json").$type<RunTestSpec>().notNull(),
    platform_config_encrypted: jsonb("platform_config_encrypted"),
    error_text: text("error_text"),
    // Stores a SHA-256 of the provided idempotency key.
    idempotency_key: text("idempotency_key"),
    agent_session_id: uuid("agent_session_id").references(() => agentSessions.id),
  },
  (table) => ({
    runsUserIdIdx: index("idx_runs_user_id").on(table.user_id),
    runsUserScopedIdempotency: uniqueIndex("runs_user_id_idempotency_key_unique")
      .on(table.user_id, table.idempotency_key)
      .where(sql`${table.idempotency_key} IS NOT NULL`),
    // Only unfinished runs: submit admission counts them and the stuck-run
    // cleanup scans them. Finished runs leave the index, so it stays tiny.
    runsOpenIdx: index("runs_open_idx")
      .on(table.status)
      .where(sql`${table.status} IN ('queued', 'running')`),
  }),
);

export const scenarioResults = pgTable(
  "scenario_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    run_id: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: scenarioStatusEnum("status").notNull(),
    metrics_json: jsonb("metrics_json").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    scenarioResultsRunIdIdx: index("scenario_results_run_id_idx").on(table.run_id),
  }),
);

export const accessTokens = pgTable("access_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  user_id: text("user_id").notNull(),
  token_hash: text("token_hash").notNull().unique(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull().default(""),
  revoked_at: timestamp("revoked_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => ({
  accessTokensUserIdIdx: index("idx_access_tokens_user_id").on(table.user_id),
}));

export const deviceSessions = pgTable("device_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  session_id: text("session_id").notNull().unique(),
  user_code: text("user_code").notNull().unique(),
  user_id: text("user_id"),
  access_token_id: uuid("access_token_id").references(() => accessTokens.id),
  raw_access_token: text("raw_access_token"),
  expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  consumed_at: timestamp("consumed_at", { withTimezone: true }),
});

export const agentSessions = pgTable("agent_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  user_id: text("user_id").notNull(),
  access_token_id: uuid("access_token_id")
    .notNull()
    .references(() => accessTokens.id),
  relay_token: text("relay_token").notNull(),
  status: agentSessionStatusEnum("status").notNull().default("connecting"),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  closed_at: timestamp("closed_at", { withTimezone: true }),
});

export const runEvents = pgTable(
  "run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    run_id: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    event_type: text("event_type").notNull(),
    message: text("message").notNull(),
    metadata_json: jsonb("metadata_json"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    runEventsRunIdCreatedAtIdx: index("run_events_run_id_created_at_idx").on(
      table.run_id,
      table.created_at,
    ),
  }),
);
