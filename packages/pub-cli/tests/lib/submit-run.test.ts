import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { after, before, beforeEach, mock, test } from "node:test";

// No saved credentials: requests use the token passed in.
const directory = mkdtempSync(path.join(tmpdir(), "vent-submit-test-"));
mock.module("node:os", { namedExports: { homedir: () => directory } });
mock.module("@vent/shared", { namedExports: {
  AccessCredentialsSchema: createRequire(import.meta.url)("@vent/shared").AccessCredentialsSchema,
} });
const originalFetch = globalThis.fetch;
let submitRun: typeof import("../../src/lib/submit-run.js").submitRun;
before(async () => ({ submitRun } = await import("../../src/lib/submit-run.js")));
after(() => { globalThis.fetch = originalFetch; });

// Fake API: each request takes the next outcome; records the keys it was sent.
let keys: string[] = [];
function api(...outcomes: Array<number | "drop">) {
  keys = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    keys.push(JSON.parse(String(init.body)).idempotency_key);
    const outcome = outcomes[keys.length - 1]!;
    if (outcome === "drop") throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ run_id: "run-a" }), { status: outcome });
  }) as typeof fetch;
}
beforeEach(() => { keys = []; });

test("a submit whose connection dropped is sent again with the same key", async () => {
  api("drop", 200);
  const res = await submitRun("token", { config: {} });
  assert.deepEqual(await res.json(), { run_id: "run-a" });
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

test("a submit that hit a restarting API machine is sent again with the same key", async () => {
  api(503, 200);
  await submitRun("token", { config: {} });
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

test("errors the API really answered are not retried", async () => {
  for (const status of [400, 429]) {
    api(status);
    await assert.rejects(submitRun("token", { config: {} }), new RegExp(`API error ${status}`));
    assert.equal(keys.length, 1);
  }
});

test("separate vent runs use different keys, so repeating a scenario starts a new run", async () => {
  api(200);
  await submitRun("token", { config: {} });
  const first = keys[0];
  api(200);
  await submitRun("token", { config: {} });
  assert.notEqual(keys[0], first);
});
