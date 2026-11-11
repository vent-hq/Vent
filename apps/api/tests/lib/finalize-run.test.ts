import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, mock, test } from "node:test";
import type { FastifyInstance } from "fastify";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

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

interface Run { id: string; status: string; error_text?: string | null; result_json?: unknown }

// In-memory stand-in for the runs table. The UPDATE matches a row only when
// the WHERE parameters contain both its id and its current status, which is
// what the real guarded query does.
function createApp(initialStatus: string) {
  const run: Run = { id: randomUUID(), status: initialStatus };
  const params = (where: SQL) => new PgDialect().sqlToQuery(where).params;
  const app = {
    db: {
      update: () => ({ set: (values: Partial<Run>) => ({ where: (where: SQL) => ({ returning: async () => {
        const p = params(where);
        if (!p.includes(run.id) || !p.includes(run.status)) return [];
        Object.assign(run, values);
        return [{ id: run.id }];
      } }) }) }),
    },
    redis: new Proxy({}, { get() { throw new Error("Finishing a run must not access Redis capacity"); } }),
    log: { info: () => {} },
  } as unknown as FastifyInstance;
  return { app, run };
}

const result = {
  name: "booking", caller_prompt: "Book a table", status: "completed", transcript: [], duration_ms: 1200,
} as unknown as import("../../src/lib/finalize-run.js").FinalizeRunInput["result"];

test("the first path to end a run wins and later ones change nothing", async () => {
  broadcasts.length = 0;
  const { app, run } = createApp("running");

  assert.equal(await finalizeRun(app, { runId: run.id, status: "pass", from: ["running"], result }), true);
  // A late worker error report, and a retried result callback.
  assert.equal(await finalizeRun(app, { runId: run.id, status: "fail", from: ["queued", "running"], errorText: "fetch failed" }), false);
  assert.equal(await finalizeRun(app, { runId: run.id, status: "pass", from: ["running"], result }), false);

  assert.equal(run.status, "pass");
  assert.equal(run.error_text, null);
  assert.deepEqual(run.result_json, result);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0]!.event.event_type, "run_complete");
});

test("a result callback cannot overwrite a cancelled run", async () => {
  broadcasts.length = 0;
  const { app, run } = createApp("queued");

  assert.equal(await finalizeRun(app, { runId: run.id, status: "cancelled", from: ["queued"], errorText: "Cancelled by user" }), true);
  assert.equal(await finalizeRun(app, { runId: run.id, status: "pass", from: ["running"], result }), false);

  assert.equal(run.status, "cancelled");
  assert.equal(run.result_json, undefined);
  assert.equal(broadcasts.length, 1);
});

test("a run that fails before any result still tells the CLI why", async () => {
  broadcasts.length = 0;
  const { app, run } = createApp("running");

  assert.equal(await finalizeRun(app, {
    runId: run.id, status: "fail", from: ["queued", "running"], errorText: "relay not found",
  }), true);

  // The stream reads the reason from the run row when it serves the result.
  assert.equal(run.status, "fail");
  assert.equal(run.error_text, "relay not found");
  assert.equal(run.result_json, undefined);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0]!.event.event_type, "run_complete");
});
