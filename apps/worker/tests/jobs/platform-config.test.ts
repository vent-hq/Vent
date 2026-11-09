import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database } from "@vent/db";
import { encryptPlatformConfig } from "@vent/platform-connections";
import { loadRunPlatformConfig } from "../../src/jobs/platform-config.js";

const previousKey = process.env["PLATFORM_CONNECTIONS_MASTER_KEY"];
process.env["PLATFORM_CONNECTIONS_MASTER_KEY"] = "12".repeat(32);
after(() => {
  if (previousKey === undefined) delete process.env["PLATFORM_CONNECTIONS_MASTER_KEY"];
  else process.env["PLATFORM_CONNECTIONS_MASTER_KEY"] = previousKey;
});
const platform = { provider: "bland" as const, bland_api_key: "FAKE_KEY", task: "Test booking", voice: "maya" };
const secondPlatform = { ...platform, voice: "josh" };
const rows = [
  { id: randomUUID(), user_id: "alice", platform_config_encrypted: encryptPlatformConfig(platform) },
  { id: randomUUID(), user_id: "alice", platform_config_encrypted: encryptPlatformConfig(secondPlatform) },
  { id: randomUUID(), user_id: "alice", platform_config_encrypted: null },
];

function createTestDb() {
  let queryCount = 0;
  const db = {
    select: () => ({ from: () => ({ where: (condition: SQL) => ({ limit: async () => {
      queryCount++;
      const { params } = new PgDialect().sqlToQuery(condition);
      return rows.filter((row) => params.includes(row.id) && params.includes(row.user_id));
    } }) }) }),
  } as unknown as Database;
  return { db, queryCount: () => queryCount };
}

test("worker loads the configuration belonging to the specific run", async () => {
  const { db } = createTestDb();
  assert.deepEqual(await loadRunPlatformConfig(db, rows[0]!.id, "alice", "bland"), platform);
  assert.deepEqual(await loadRunPlatformConfig(db, rows[1]!.id, "alice", "bland"), secondPlatform);
  assert.deepEqual(await loadRunPlatformConfig(db, rows[0]!.id, "alice", "bland"), platform);
});

test("another customer cannot load a run's configuration", async () => {
  const { db } = createTestDb();
  await assert.rejects(loadRunPlatformConfig(db, rows[0]!.id, "bob", "bland"), /not found/);
  await assert.rejects(loadRunPlatformConfig(db, rows[0]!.id, "", "bland"), /owner is required/);
});

test("missing run or missing provider configuration fails", async () => {
  const { db } = createTestDb();
  await assert.rejects(loadRunPlatformConfig(db, randomUUID(), "alice", "bland"), /not found/);
  await assert.rejects(loadRunPlatformConfig(db, rows[2]!.id, "alice", "bland"), /not found/);
});

test("stored provider must match the job adapter", async () => {
  const { db } = createTestDb();
  await assert.rejects(loadRunPlatformConfig(db, rows[0]!.id, "alice", "vapi"), /does not match/);
});

test("custom WebSocket runs do not load provider credentials", async () => {
  const { db, queryCount } = createTestDb();
  assert.equal(await loadRunPlatformConfig(db, randomUUID(), "alice", "websocket"), undefined);
  assert.equal(queryCount(), 0);
});
