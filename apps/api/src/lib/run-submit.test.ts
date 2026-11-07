import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { decryptPlatformConfig, type EncryptedPlatformConfig } from "@vent/platform-connections";
import { buildCallSpec, RunSubmitConfigSchema, submitRun } from "./run-submit.js";

const previousKey = process.env["PLATFORM_CONNECTIONS_MASTER_KEY"];
process.env["PLATFORM_CONNECTIONS_MASTER_KEY"] = "12".repeat(32);
after(() => {
  if (previousKey === undefined) delete process.env["PLATFORM_CONNECTIONS_MASTER_KEY"];
  else process.env["PLATFORM_CONNECTIONS_MASTER_KEY"] = previousKey;
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

function createSubmitApp() {
  const rows: StoredRun[] = [];
  const jobs: Record<string, unknown>[] = [];
  const db = {
    select: () => ({ from: () => ({ where: (condition: SQL) => ({ limit: async () => {
      const { params } = new PgDialect().sqlToQuery(condition);
      return rows.filter((row) => params.includes(row.user_id) && params.includes(row.idempotency_key));
    } }) }) }),
    insert: () => ({ values: (values: Record<string, unknown>) => ({ returning: async () => {
      const row = { id: randomUUID(), ...structuredClone(values) } as StoredRun;
      rows.push(row);
      return [row];
    } }) }),
  };
  const app = {
    db,
    redis: { eval: async () => 1, scard: async () => rows.length },
    getRunQueue: () => ({ add: async (_name: string, job: Record<string, unknown>) => { jobs.push(job); } }),
    markRunQueueActive: async () => {},
  } as unknown as FastifyInstance;
  return { app, rows, jobs };
}

test("runs for the same agent keep independent encrypted configurations", async () => {
  const { app, rows, jobs } = createSubmitApp();
  const params = { accessTokenId: randomUUID(), userId: "alice" };
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
  const params = { accessTokenId: randomUUID(), userId: "alice", idempotencyKey: randomUUID() };
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
  const params = { accessTokenId: randomUUID(), config: config(), idempotencyKey: randomUUID() };
  const first = await submitRun(app, { ...params, userId: "alice" });
  const second = await submitRun(app, { ...params, userId: "bob" });
  assert.notEqual(first.run_id, second.run_id);
  assert.equal(rows.length, 2);
});

test("provider, adapter, and resolved credentials are validated before submission", () => {
  assert.equal(RunSubmitConfigSchema.safeParse({ connection: { adapter: "bland" }, call }).success, false);
  for (const adapter of ["vapi", "websocket"]) {
    assert.equal(RunSubmitConfigSchema.safeParse({ connection: { adapter, platform }, call }).success, false);
  }
  const missingKey = RunSubmitConfigSchema.safeParse({
    connection: { adapter: "bland", platform: { ...platform, bland_api_key: undefined } }, call,
  });
  assert.equal(missingKey.success, false);
  if (!missingKey.success) assert.equal(missingKey.error.message.includes("FAKE_"), false);
});

test("custom WebSocket runs do not require or store provider configuration", async () => {
  const { app, rows } = createSubmitApp();
  await submitRun(app, { accessTokenId: randomUUID(), userId: "alice", config: RunSubmitConfigSchema.parse({
    connection: { adapter: "websocket", agent_url: "wss://example.invalid/agent" }, call,
  }) });
  assert.equal(rows[0]!.platform_config_encrypted, null);
});

test("public run metadata excludes platform configuration", () => {
  const { callSpecJson } = buildCallSpec({ adapter: "bland", call, platform });
  assert.equal(Object.hasOwn(callSpecJson, "platform"), false);
  assert.equal(JSON.stringify(callSpecJson).includes("FAKE_"), false);
});
