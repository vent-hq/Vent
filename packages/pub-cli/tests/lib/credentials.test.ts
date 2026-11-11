import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, mock, test } from "node:test";
import { SignJWT } from "jose";
import { createRequire } from "node:module";

const directory = mkdtempSync(path.join(tmpdir(), "vent-auth-test-"));
const file = path.join(directory, ".vent", "credentials");
const originalFetch = globalThis.fetch;
const previousAccess = process.env.VENT_ACCESS_TOKEN;
const previousRefresh = process.env.VENT_REFRESH_TOKEN;
mock.module("node:os", { namedExports: { homedir: () => directory } });
mock.module("@vent/shared", { namedExports: {
  AccessCredentialsSchema: createRequire(import.meta.url)("@vent/shared").AccessCredentialsSchema,
} });
let config: typeof import("../../src/lib/config.js");
let api: typeof import("../../src/lib/api.js");
before(async () => {
  config = await import("../../src/lib/config.js");
  api = await import("../../src/lib/api.js");
});
beforeEach(async () => {
  delete process.env.VENT_ACCESS_TOKEN;
  delete process.env.VENT_REFRESH_TOKEN;
  await rm(file, { force: true });
  globalThis.fetch = async () => { throw new Error("Unexpected HTTP request"); };
});
after(async () => {
  globalThis.fetch = originalFetch;
  if (previousAccess === undefined) delete process.env.VENT_ACCESS_TOKEN;
  else process.env.VENT_ACCESS_TOKEN = previousAccess;
  if (previousRefresh === undefined) delete process.env.VENT_REFRESH_TOKEN;
  else process.env.VENT_REFRESH_TOKEN = previousRefresh;
  await rm(directory, { recursive: true, force: true });
});
const refreshToken = `vent_${"12".repeat(24)}`;
const token = (expiresIn: number) => new SignJWT({ sub: "user-test" })
  .setProtectedHeader({ alg: "HS256" }).setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
  .sign(new Uint8Array(32).fill(1));

test("fresh access credentials are reused and only necessary fields are stored with private permissions", async () => {
  const accessToken = await token(900);
  await config.saveCredentials({ access_token: accessToken, refresh_token: refreshToken });
  assert.equal(await config.loadAccessToken(), accessToken);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file, "utf8"))).sort(), ["access_token", "refresh_token"]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("concurrent loads of expired credentials share one renewal request", async () => {
  await config.saveCredentials({ access_token: await token(-1), refresh_token: refreshToken });
  const fresh = await token(900);
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    requests++;
    assert.ok(String(input).endsWith("/auth/refresh"));
    assert.deepEqual(JSON.parse(String(init?.body)), { refresh_token: refreshToken });
    await new Promise(resolve => setImmediate(resolve));
    return Response.json({ access_token: fresh, refresh_token: refreshToken });
  };
  assert.deepEqual(await Promise.all([config.loadAccessToken(), config.loadAccessToken()]), [fresh, fresh]);
  assert.equal(requests, 1);
  assert.equal(JSON.parse(await readFile(file, "utf8")).access_token, fresh);
});

test("an environment refresh credential works without a saved login or access token", async () => {
  process.env.VENT_REFRESH_TOKEN = refreshToken;
  const fresh = await token(900);
  globalThis.fetch = async () => Response.json({ access_token: fresh, refresh_token: refreshToken });
  assert.equal(await config.loadAccessToken(), fresh);
  assert.equal(process.env.VENT_ACCESS_TOKEN, fresh);
  await assert.rejects(stat(file), { code: "ENOENT" });
});

test("an unauthorized API request refreshes and retries at most once", async () => {
  for (const finalStatus of [200, 401]) {
    await config.saveCredentials({ access_token: await token(900), refresh_token: refreshToken });
    const fresh = await token(950);
    let renewals = 0;
    let requests = 0;
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith("/auth/refresh")) {
        renewals++;
        return Response.json({ access_token: fresh, refresh_token: refreshToken });
      }
      requests++;
      if (requests === 2) assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${fresh}`);
      return Response.json({ ok: false }, { status: requests === 1 ? 401 : finalStatus });
    };
    if (finalStatus === 200) assert.equal((await api.apiFetch("/runs/test")).status, 200);
    else await assert.rejects(api.apiFetch("/runs/test"), (error: unknown) => error instanceof api.ApiError && error.status === 401);
    assert.equal(renewals, 1);
    assert.equal(requests, 2);
  }
});

test("revoked credentials return a useful error without leaking the refresh credential", async () => {
  await config.saveCredentials({ access_token: await token(-1), refresh_token: refreshToken });
  globalThis.fetch = async () => Response.json({ error: "Invalid refresh credential" }, { status: 401 });
  await assert.rejects(config.loadAccessToken(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /login/);
    assert.equal(error.message.includes(refreshToken), false);
    return true;
  });
});

test("SSE uses renewed access credentials instead of reconnecting forever with an expired token", async () => {
  await config.saveCredentials({ access_token: await token(900), refresh_token: refreshToken });
  const fresh = await token(950);
  let opens = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/auth/refresh")) return Response.json({ access_token: fresh, refresh_token: refreshToken });
    if (++opens === 1) return new Response(null, { status: 401 });
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${fresh}`);
    return new Response('data: {"event_type":"run_complete"}\n\n', { headers: { "content-type": "text/event-stream" } });
  };
  const { streamRunEvents } = await import("../../src/lib/sse.js");
  const events = [];
  for await (const event of streamRunEvents("run-test", false)) events.push(event);
  assert.deepEqual(events, [{ event_type: "run_complete" }]);
  assert.equal(opens, 2);
});
