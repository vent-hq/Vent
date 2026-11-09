import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, mock, test } from "node:test";
import type { FastifyInstance } from "fastify";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { schema } from "@vent/db";

const broadcasts: { runId: string; event: Record<string, unknown> }[] = [];
mock.module("../../src/lib/run-subscribers.js", {
  namedExports: {
    broadcast: (runId: string, event: Record<string, unknown>) => broadcasts.push({ runId, event }),
  },
});
let finalizeRun: typeof import("../../src/lib/finalize-run.js").finalizeRun;
before(async () => {
  ({ finalizeRun } = await import("../../src/lib/finalize-run.js"));
});

interface Run { id: string; status: string; error_text?: string | null }

// In-memory stand-in for the three tables finalizeRun writes. The runs UPDATE
// matches a row only when the WHERE parameters contain both its id and its
// current status, which is what the real guarded query does.
function createApp(initialStatus: string) {
  const run: Run = { id: randomUUID(), status: initialStatus };
  const events: Record<string, unknown>[] = [];
  const results: Record<string, unknown>[] = [];
  const params = (where: SQL) => new PgDialect().sqlToQuery(where).params;
  const tx = {
    update: () => ({ set: (values: Partial<Run>) => ({ where: (where: SQL) => ({ returning: async () => {
      const p = params(where);
      if (!p.includes(run.id) || !p.includes(run.status)) return [];
      Object.assign(run, values);
      return [{ id: run.id }];
    } }) }) }),
    delete: () => ({ where: async () => { results.length = 0; } }),
    insert: (table: unknown) => ({ values: (values: Record<string, unknown>) => {
      if (table === schema.scenarioResults) { results.push(values); return Promise.resolve(); }
      return { returning: async () => {
        const row = { id: randomUUID(), created_at: new Date(), ...values };
        events.push(row);
        return [row];
      } };
    } }),
  };
  const app = {
    db: { transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) },
    redis: new Proxy({}, { get() { throw new Error("Finishing a run must not access Redis capacity"); } }),
    log: { info: () => {} },
  } as unknown as FastifyInstance;
  return { app, run, events, results };
}

const result = {
  conversation_result: { name: "booking", caller_prompt: "Book a table", status: "completed", transcript: [] },
  aggregate: { conversation_calls: { total: 1, passed: 1, failed: 0 }, total_duration_ms: 1200 },
} as unknown as import("../../src/lib/finalize-run.js").FinalizeRunInput["result"];

test("the first path to end a run wins and later ones change nothing", async () => {
  broadcasts.length = 0;
  const { app, run, events } = createApp("running");

  assert.equal(await finalizeRun(app, { runId: run.id, status: "pass", from: ["running"], result }), true);
  // A late worker error report, and a retried result callback.
  assert.equal(await finalizeRun(app, { runId: run.id, status: "fail", from: ["queued", "running"], errorText: "fetch failed" }), false);
  assert.equal(await finalizeRun(app, { runId: run.id, status: "pass", from: ["running"], result }), false);

  assert.equal(run.status, "pass");
  assert.equal(run.error_text, null);
  assert.equal(events.filter((e) => e.event_type === "run_complete").length, 1);
  assert.equal(broadcasts.length, 1);
});

test("a result callback cannot overwrite a cancelled run", async () => {
  const { app, run, events, results } = createApp("queued");

  assert.equal(await finalizeRun(app, { runId: run.id, status: "cancelled", from: ["queued"], errorText: "Cancelled by user" }), true);
  assert.equal(await finalizeRun(app, { runId: run.id, status: "pass", from: ["running"], result }), false);

  assert.equal(run.status, "cancelled");
  assert.equal(results.length, 0);
  assert.equal(events.length, 1);
});

test("a run that fails before any result still tells the CLI why", async () => {
  broadcasts.length = 0;
  const { app, run, results } = createApp("running");

  assert.equal(await finalizeRun(app, {
    runId: run.id, status: "fail", from: ["queued", "running"], errorText: "relay not found",
  }), true);

  assert.equal(run.status, "fail");
  assert.equal(results.length, 0);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0]!.event.event_type, "run_complete");
  assert.deepEqual(broadcasts[0]!.event.metadata_json, { status: "fail", error_text: "relay not found" });
});
