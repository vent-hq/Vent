import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, mock, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { decryptPlatformConfig, type EncryptedPlatformConfig } from "@vent/platform-connections";

// run_complete announcements finalizeRun published to CLI streams.
const published: Record<string, unknown>[] = [];
mock.module("../../src/lib/run-subscribers.js", { namedExports: {
  broadcast(_runId: string, event: Record<string, unknown>) { published.push(event); },
} });
let buildCallSpec: typeof import("../../src/lib/run-submit.js").buildCallSpec;
let RunSubmitConfigSchema: typeof import("../../src/lib/run-submit.js").RunSubmitConfigSchema;
let submitRun: typeof import("../../src/lib/run-submit.js").submitRun;
let FleetCapacityError: typeof import("../../src/lib/run-submit.js").FleetCapacityError;
let finalizeRun: typeof import("../../src/lib/finalize-run.js").finalizeRun;
before(async () => {
  ({ buildCallSpec, RunSubmitConfigSchema, submitRun, FleetCapacityError } = await import("../../src/lib/run-submit.js"));
  ({ finalizeRun } = await import("../../src/lib/finalize-run.js"));
});

const previousKey = process.env["PLATFORM_CONNECTIONS_MASTER_KEY"];
const previousCap = process.env["FLEET_MAX_ACTIVE_RUNS"];
process.env["PLATFORM_CONNECTIONS_MASTER_KEY"] = "12".repeat(32);
process.env["FLEET_MAX_ACTIVE_RUNS"] = "2";
after(() => {
  if (previousKey === undefined) delete process.env["PLATFORM_CONNECTIONS_MASTER_KEY"];
  else process.env["PLATFORM_CONNECTIONS_MASTER_KEY"] = previousKey;
  if (previousCap === undefined) delete process.env["FLEET_MAX_ACTIVE_RUNS"];
  else process.env["FLEET_MAX_ACTIVE_RUNS"] = previousCap;
});

const platform = {
  provider: "bland" as const,
  bland_api_key: "FAKE_PROVIDER_KEY",
  bland_pathway_id: "agent_123",
  voice: "maya",
  tools: [{ headers: { Authorization: "Bearer FAKE_TOOL_KEY" } }],
  request_data: { arbitrary: "FAKE_OTHER_SECRET" },
};
const call = { caller_prompt: "Test booking", max_turns: 3 };
const config = (settings = platform) => RunSubmitConfigSchema.parse({
  connection: { adapter: settings.provider, platform: settings }, call,
});

interface StoredRun extends Record<string, unknown> {
  id: string;
  user_id: string;
  status: string;
  idempotency_key: string | null;
  platform_config_encrypted: EncryptedPlatformConfig | null;
  test_spec_json: Record<string, unknown>;
}

function createSubmitApp(options: { enqueueFails?: boolean; claimBeforeEnqueueError?: boolean } = {}) {
  const rows: StoredRun[] = [];
  const jobs: Record<string, unknown>[] = [];
  published.length = 0;
  const events = published;
  let previousTransaction = Promise.resolve();
  let admissionLocked = false;
  const params = (condition: SQL) => new PgDialect().sqlToQuery(condition).params;
  const db = {
    execute: async (query: SQL) => {
      assert.match(new PgDialect().sqlToQuery(query).sql, /pg_advisory_xact_lock/);
      admissionLocked = true;
    },
    select: (fields: Record<string, unknown>) => ({ from: () => ({ where: (condition: SQL) => {
      assert.equal(admissionLocked, true);
      const values = params(condition);
      if ("total" in fields) {
        // The admission count writes its statuses into the SQL text (for runs_open_idx).
        assert.match(new PgDialect().sqlToQuery(condition).sql, /"status" IN \('queued', 'running'\)/);
        return Promise.resolve([{ total: rows.filter(row => row.status === "queued" || row.status === "running").length }]);
      }
      return { limit: async () => rows.filter(row => values.includes(row.user_id) && values.includes(row.idempotency_key)) };
    } }) }),
    insert: () => ({ values: (values: Record<string, unknown>) => ({ returning: async () => {
      const row: Record<string, unknown> = { id: randomUUID(), created_at: new Date(), ...structuredClone(values) };
      rows.push(row as StoredRun);
      return [row];
    } }) }),
    update: () => ({ set: (values: Record<string, unknown>) => ({ where: (condition: SQL) => ({ returning: async () => {
      const accepted = params(condition);
      const row = rows.find(row => accepted.includes(row.id) && accepted.includes(row.status));
      if (!row) return [];
      Object.assign(row, values);
      return [{ id: row.id }];
    } }) }) }),
  };
  const app = {
    db: { ...db, transaction: async (fn: (tx: typeof db) => Promise<unknown>) => {
      const previous = previousTransaction;
      let release!: () => void;
      previousTransaction = new Promise<void>(resolve => { release = resolve; });
      await previous;
      const savedRows = structuredClone(rows);
      admissionLocked = false;
      try { return await fn(db); }
      catch (error) { rows.splice(0, rows.length, ...savedRows); throw error; }
      finally { admissionLocked = false; release(); }
    } },
    redis: new Proxy({}, { get() { throw new Error("Capacity tracking must not access Redis"); } }),
    runQueue: { add: async (_name: string, job: Record<string, unknown>) => {
      if (options.claimBeforeEnqueueError) rows.find(row => row.id === job.run_id)!.status = "running";
      if (options.enqueueFails) throw new Error("Queue unavailable");
      jobs.push(job);
    } },
    log: { info() {}, error() {} },
  } as unknown as FastifyInstance;
  return { app, rows, jobs, events };
}

test("runs for the same agent keep independent encrypted configurations", async () => {
  const { app, rows, jobs } = createSubmitApp();
  const params = { userId: "alice" };
  const first = await submitRun(app, { ...params, config: config() });
  const secondSettings = { ...platform, voice: "josh", bland_api_key: "FAKE_NEW_KEY" };
  const second = await submitRun(app, { ...params, config: config(secondSettings) });
  assert.notEqual(first.run_id, second.run_id);
  assert.equal(rows.length, 2);
  assert.deepEqual(decryptPlatformConfig(rows[0]!.platform_config_encrypted!), platform);
  assert.deepEqual(decryptPlatformConfig(rows[1]!.platform_config_encrypted!), secondSettings);
  assert.equal(JSON.stringify({ rows, jobs, first, second }).includes("FAKE_"), false);
  for (const row of rows) {
    assert.equal(Object.hasOwn(row.test_spec_json, "platform"), false);
    assert.equal(Object.hasOwn(row.test_spec_json, "platform_connection_id"), false);
    assert.deepEqual(row.test_spec_json.call, call);
  }
  for (const job of jobs) {
    assert.equal(Object.hasOwn(job, "platform_config_encrypted"), false);
    assert.equal(Object.hasOwn(job, "platform_connection_id"), false);
  }
});

test("retrying an idempotent submission preserves the original run and configuration", async () => {
  const { app, rows, jobs } = createSubmitApp();
  const params = { userId: "alice", idempotencyKey: randomUUID() };
  const first = await submitRun(app, { ...params, config: config() });
  const retry = await submitRun(app, { ...params, config: config({ ...platform, voice: "josh" }) });
  assert.equal(retry.run_id, first.run_id);
  assert.equal(retry.deduplicated, true);
  assert.equal(rows.length, 1);
  assert.equal(jobs.length, 1);
  assert.deepEqual(decryptPlatformConfig(rows[0]!.platform_config_encrypted!), platform);
});

test("different customers can use the same submission idempotency key", async () => {
  const { app, rows } = createSubmitApp();
  const params = { config: config(), idempotencyKey: randomUUID() };
  const first = await submitRun(app, { ...params, userId: "alice" });
  const second = await submitRun(app, { ...params, userId: "bob" });
  assert.notEqual(first.run_id, second.run_id);
  assert.equal(rows.length, 2);
});

test("caller accents must be one of the supported voices", () => {
  const withAccent = (accent: string) => RunSubmitConfigSchema.safeParse({
    connection: { adapter: "websocket", agent_url: "wss://example.invalid/agent" },
    call: { ...call, caller_audio: { accent } },
  });
  for (const accent of ["british", "spanish_mexican", "japanese"]) assert.equal(withAccent(accent).success, true, accent);
  for (const accent of ["britsh", "scottish", "aura-2-draco-en"]) {
    const parsed = withAccent(accent);
    assert.equal(parsed.success, false, accent);
    if (!parsed.success) assert.match(parsed.error.message, /british/);
  }
});

test("provider, adapter, and resolved credentials are validated before submission", () => {
  assert.equal(RunSubmitConfigSchema.safeParse({ connection: { adapter: "bland" }, call }).success, false);
  for (const adapter of ["vapi", "websocket"]) {
    assert.equal(RunSubmitConfigSchema.safeParse({ connection: { adapter, platform }, call }).success, false);
  }
  const personaOnly = RunSubmitConfigSchema.safeParse({
    connection: { adapter: "bland", platform: { provider: "bland", bland_api_key: "FAKE_PROVIDER_KEY", persona_id: "persona_123" } },
    call,
  });
  assert.equal(personaOnly.success, false);
  if (!personaOnly.success) assert.match(personaOnly.error.message, /bland_pathway_id or task/);

  const missingKey = RunSubmitConfigSchema.safeParse({
    connection: { adapter: "bland", platform: { ...platform, bland_api_key: undefined } }, call,
  });
  assert.equal(missingKey.success, false);
  if (!missingKey.success) assert.equal(missingKey.error.message.includes("FAKE_"), false);
});

test("custom WebSocket runs do not require or store provider configuration", async () => {
  const { app, rows } = createSubmitApp();
  await submitRun(app, { userId: "alice", config: RunSubmitConfigSchema.parse({
    connection: { adapter: "websocket", agent_url: "wss://example.invalid/agent" }, call,
  }) });
  assert.equal(rows[0]!.platform_config_encrypted, null);
});

test("public run metadata excludes platform configuration", () => {
  const { callSpecJson } = buildCallSpec({ adapter: "bland", call, platform });
  assert.equal(Object.hasOwn(callSpecJson, "platform"), false);
  assert.equal(JSON.stringify(callSpecJson).includes("FAKE_"), false);
});

test("the fleet limit counts queued and running calls across all users", async () => {
  const { app, rows, jobs } = createSubmitApp();
  const params = { config: config() };
  await submitRun(app, { ...params, userId: "alice" });
  rows[0]!.status = "running";
  await submitRun(app, { ...params, userId: "bob" });
  await assert.rejects(submitRun(app, { ...params, userId: "charlie" }), FleetCapacityError);
  assert.equal(rows.length, 2);
  assert.equal(jobs.length, 2);
});

test("concurrent submissions cannot both take the last place", async () => {
  const { app, rows, jobs } = createSubmitApp();
  const params = { config: config(), userId: "alice" };
  await submitRun(app, params);
  const outcomes = await Promise.allSettled([submitRun(app, params), submitRun(app, params)]);
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(outcome => outcome.status === "rejected" && outcome.reason instanceof FleetCapacityError).length, 1);
  assert.equal(rows.length, 2);
  assert.equal(jobs.length, 2);
});

test("concurrent retries reuse an existing run even when the fleet is full", async () => {
  const { app, rows, jobs } = createSubmitApp();
  const params = { config: config(), userId: "alice", idempotencyKey: randomUUID() };
  const [first, retry] = await Promise.all([submitRun(app, params), submitRun(app, params)]);
  await submitRun(app, { ...params, userId: "bob" });
  const fullRetry = await submitRun(app, params);
  assert.equal(retry.run_id, first.run_id);
  assert.equal(retry.deduplicated, true);
  assert.equal(fullRetry.run_id, first.run_id);
  assert.equal(fullRetry.deduplicated, true);
  assert.equal(rows.length, 2);
  assert.equal(jobs.length, 2);
});

test("finishing a run frees capacity without any Redis capacity operation", async () => {
  const { app, rows, events } = createSubmitApp();
  const params = { config: config(), userId: "alice" };
  const first = await submitRun(app, params);
  await submitRun(app, params);
  await finalizeRun(app, { runId: first.run_id, status: "pass", from: ["queued", "running"] });
  await submitRun(app, params);
  assert.equal(rows.filter(row => row.status === "queued" || row.status === "running").length, 2);
  assert.equal(events.length, 1);
});

test("queue submission failure ends the queued run and frees its capacity", async () => {
  const { app, rows, events } = createSubmitApp({ enqueueFails: true });
  const params = { config: config(), userId: "alice" };
  for (let i = 0; i < 3; i++) await assert.rejects(submitRun(app, params), /Queue unavailable/);
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row.status === "fail"));
  assert.equal(events.length, 3);
});

test("an ambiguous queue error cannot free a run already claimed by a worker", async () => {
  const { app, rows, events } = createSubmitApp({ enqueueFails: true, claimBeforeEnqueueError: true });
  await assert.rejects(submitRun(app, { config: config(), userId: "alice" }), /Queue unavailable/);
  assert.equal(rows[0]!.status, "running");
  assert.equal(events.length, 0);
});

test("missing or invalid fleet limits reject submission before creating a run", async () => {
  const { app, rows, jobs } = createSubmitApp();
  const params = { config: config(), userId: "alice" };
  try {
    delete process.env["FLEET_MAX_ACTIVE_RUNS"];
    await assert.rejects(submitRun(app, params), /FLEET_MAX_ACTIVE_RUNS/);
    for (const value of ["0", "-1", "1.5", "invalid"]) {
      process.env["FLEET_MAX_ACTIVE_RUNS"] = value;
      await assert.rejects(submitRun(app, params), /positive integer/);
    }
    assert.equal(rows.length, 0);
    assert.equal(jobs.length, 0);
  } finally { process.env["FLEET_MAX_ACTIVE_RUNS"] = "2"; }
});
