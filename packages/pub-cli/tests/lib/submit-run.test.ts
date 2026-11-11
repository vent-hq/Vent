import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { after, before, beforeEach, mock, test } from "node:test";
import { SignJWT } from "jose";

// No saved credentials: requests use the access token from the environment.
const directory = mkdtempSync(path.join(tmpdir(), "vent-submit-test-"));
const previousAccess = process.env.VENT_ACCESS_TOKEN;
const previousRefresh = process.env.VENT_REFRESH_TOKEN;
mock.module("node:os", { namedExports: { homedir: () => directory } });
mock.module("@vent/shared", { namedExports: {
  AccessCredentialsSchema: createRequire(import.meta.url)("@vent/shared").AccessCredentialsSchema,
} });
const originalFetch = globalThis.fetch;
let submitRun: typeof import("../../src/lib/submit-run.js").submitRun;
before(async () => {
  delete process.env.VENT_REFRESH_TOKEN;
  process.env.VENT_ACCESS_TOKEN = await new SignJWT({ sub: "user-test" })
    .setProtectedHeader({ alg: "HS256" }).setExpirationTime("15m")
    .sign(new Uint8Array(32).fill(1));
  ({ submitRun } = await import("../../src/lib/submit-run.js"));
});
after(() => {
  globalThis.fetch = originalFetch;
  if (previousAccess === undefined) delete process.env.VENT_ACCESS_TOKEN;
  else process.env.VENT_ACCESS_TOKEN = previousAccess;
  if (previousRefresh === undefined) delete process.env.VENT_REFRESH_TOKEN;
  else process.env.VENT_REFRESH_TOKEN = previousRefresh;
});

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
  const res = await submitRun({ config: {} });
  assert.deepEqual(await res.json(), { run_id: "run-a" });
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

test("a submit that hit a restarting API machine is sent again with the same key", async () => {
  api(503, 200);
  await submitRun({ config: {} });
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

test("errors the API really answered are not retried", async () => {
  for (const status of [400, 429]) {
    api(status);
    await assert.rejects(submitRun({ config: {} }), new RegExp(`API error ${status}`));
    assert.equal(keys.length, 1);
  }
});

test("separate vent runs use different keys, so repeating a scenario starts a new run", async () => {
  api(200);
  await submitRun({ config: {} });
  const first = keys[0];
  api(200);
  await submitRun({ config: {} });
  assert.notEqual(keys[0], first);
});
