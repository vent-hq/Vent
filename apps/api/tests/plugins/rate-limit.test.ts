import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, mock, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { signCallback } from "@vent/shared";
import { recordingRoutes } from "../../src/routes/recordings.js";

mock.module("../../src/lib/rate-limit-redis.js", { namedExports: { createRateLimitRedis: () => undefined } });
mock.module("../../src/lib/run-subscribers.js", { namedExports: {
  broadcast() {},
  async subscribeToRun() { return () => {}; },
} });
let callbackRoutes: typeof import("../../src/routes/callback.js").callbackRoutes;
let runRoutes: typeof import("../../src/routes/runs.js").runRoutes;
let rateLimitPlugin: typeof import("../../src/plugins/rate-limit.js").rateLimitPlugin;
const secret = "test-callback-secret";
const previousSecret = process.env["RUNNER_CALLBACK_SECRET"];
before(async () => {
  process.env["RUNNER_CALLBACK_SECRET"] = secret;
  ({ rateLimitPlugin } = await import("../../src/plugins/rate-limit.js"));
  ({ callbackRoutes } = await import("../../src/routes/callback.js"));
  ({ runRoutes } = await import("../../src/routes/runs.js"));
});
after(() => {
  if (previousSecret === undefined) delete process.env["RUNNER_CALLBACK_SECRET"];
  else process.env["RUNNER_CALLBACK_SECRET"] = previousSecret;
});

async function createApp(trustProxy = false) {
  const app = Fastify({ trustProxy });
  const rows: Record<string, unknown>[] = [];
  app.decorate("db", { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    insert: () => ({ values: (value: Record<string, unknown>) => ({
    returning: async () => {
      const row = { id: randomUUID(), created_at: new Date(), ...value };
      rows.push(row);
      return [row];
    },
  }) }) } as unknown as FastifyInstance["db"]);
  app.addHook("preValidation", async request => {
    request.rawBody = JSON.stringify(request.body);
  });
  // Stand-in for signature verification: "Bearer test-token" proves test-user
  // and "Bearer valid:<name>" proves <name>; any other token is forged.
  const verifiedUser = (request: { headers: Record<string, unknown> }) => {
    const auth = request.headers["authorization"];
    if (auth === "Bearer test-token") return "test-user";
    return typeof auth === "string" && auth.startsWith("Bearer valid:") ? auth.slice(13) : null;
  };
  app.decorate("accessTokenUserId", async request => verifiedUser(request));
  app.decorate("verifyAccessToken", async (request, reply) => {
    const userId = verifiedUser(request);
    if (!userId) return reply.status(401).send({ error: "Unauthorized" });
    request.userId = userId;
    request.accessTokenId = randomUUID();
  });
  await app.register(rateLimitPlugin);
  app.get("/dashboard", async () => ({ ok: true }));
  app.get("/health", async () => ({ ok: true }));
  await app.register(callbackRoutes);
  await app.register(runRoutes);
  await app.register(recordingRoutes);
  await app.ready();
  return { app, rows };
}

const submitFrom = (app: FastifyInstance, ip: string, token?: string) => app.inject({
  method: "POST", url: "/runs/submit", remoteAddress: ip,
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

test("submits without a valid token, including forged ones, are limited per IP", async () => {
  const { app } = await createApp();
  try {
    for (let i = 0; i < 50; i++) {
      const response = await submitFrom(app, "192.0.2.1", i % 2 ? "forged-alice" : undefined);
      assert.equal(response.statusCode, 401);
      assert.equal(response.headers["x-ratelimit-limit"], "50");
    }
    assert.equal((await submitFrom(app, "192.0.2.1", "forged-alice")).statusCode, 429);
    assert.equal((await submitFrom(app, "192.0.2.2")).statusCode, 401);
    // The forged tokens spent the IP's budget, not alice's.
    assert.equal((await submitFrom(app, "192.0.2.1", "valid:alice")).statusCode, 400);
  } finally { await app.close(); }
});

test("logged-in users behind one IP each get their own submit budget", async () => {
  const { app } = await createApp();
  try {
    for (let i = 0; i < 50; i++) assert.equal((await submitFrom(app, "203.0.113.7", "valid:alice")).statusCode, 400);
    assert.equal((await submitFrom(app, "203.0.113.7", "valid:alice")).statusCode, 429);
    assert.equal((await submitFrom(app, "203.0.113.7", "valid:bob")).statusCode, 400);
    assert.equal((await submitFrom(app, "203.0.113.7")).statusCode, 401);
  } finally { await app.close(); }
});

test("one logged-in user shares a single submit budget across IPs", async () => {
  const { app } = await createApp();
  try {
    for (let i = 0; i < 50; i++) assert.equal((await submitFrom(app, `198.51.100.${i + 1}`, "valid:alice")).statusCode, 400);
    assert.equal((await submitFrom(app, "198.51.100.99", "valid:alice")).statusCode, 429);
  } finally { await app.close(); }
});

test("worker callbacks stay authenticated without consuming the submission allowance", async () => {
  const { app, rows } = await createApp();
  const payload = JSON.stringify({ run_id: randomUUID(), event_type: "progress", message: "Call update" });
  try {
    for (let i = 0; i < 60; i++) {
      const response = await app.inject({
        method: "POST", url: "/internal/run-event", payload,
        headers: { "content-type": "application/json", ...signCallback("POST", "/internal/run-event", payload, secret) },
      });
      assert.equal(response.statusCode, 200);
    }
    assert.equal(rows.length, 60);
    for (let i = 0; i < 50; i++) {
      assert.equal((await app.inject({ method: "POST", url: "/runs/submit" })).statusCode, 401);
    }
    assert.equal((await app.inject({ method: "POST", url: "/runs/submit" })).statusCode, 429);
    assert.equal((await app.inject({ method: "POST", url: "/internal/run-event", payload,
      headers: { "content-type": "application/json" },
    })).statusCode, 401);
    assert.equal(rows.length, 60);
  } finally { await app.close(); }
});

test("a worker callback signature is only valid for the endpoint it was made for", async () => {
  const { app, rows } = await createApp();
  const payload = JSON.stringify({ run_id: randomUUID(), event_type: "progress", message: "Call update" });
  const signedForRunEvent = { "content-type": "application/json", ...signCallback("POST", "/internal/run-event", payload, secret) };
  try {
    const moved = await app.inject({ method: "POST", url: "/internal/call-progress", payload, headers: signedForRunEvent });
    assert.equal(moved.statusCode, 401);
    const withQuery = await app.inject({ method: "POST", url: "/internal/run-event?x=1", payload, headers: signedForRunEvent });
    assert.equal(withQuery.statusCode, 200);
    assert.equal(rows.length, 1);
  } finally { await app.close(); }
});

test("query parameters cannot bypass the submission limit", async () => {
  const { app } = await createApp();
  try {
    for (let i = 0; i < 50; i++) {
      assert.equal((await app.inject({ method: "POST", url: "/runs/submit?x=/internal/run-event" })).statusCode, 401);
    }
    assert.equal((await app.inject({ method: "POST", url: "/runs/submit?x=/health" })).statusCode, 429);
    assert.equal((await app.inject({ url: "/health" })).statusCode, 200);
  } finally { await app.close(); }
});

test("dashboard and status requests do not consume the submission allowance", async () => {
  const { app } = await createApp();
  try {
    for (let i = 0; i < 100; i++) {
      assert.equal((await app.inject({ url: "/dashboard" })).statusCode, 200);
      const status = await app.inject({ url: "/runs/example", headers: { authorization: "Bearer test-token" } });
      assert.equal(status.statusCode, 404);
      assert.equal(status.headers["x-ratelimit-limit"], undefined);
    }
    for (let i = 0; i < 50; i++) {
      assert.equal((await app.inject({ method: "POST", url: "/runs/submit" })).statusCode, 401);
    }
    assert.equal((await app.inject({ method: "POST", url: "/runs/submit" })).statusCode, 429);
  } finally { await app.close(); }
});

test("rate limits use the Fly client IP and ignore forged forwarding headers on private connections", async () => {
  const previousApp = process.env["FLY_APP_NAME"];
  process.env["FLY_APP_NAME"] = "vent-test";
  const { app } = await createApp(true);
  try {
    for (let i = 0; i < 51; i++) {
      const response = await app.inject({
        method: "POST", url: "/runs/submit", remoteAddress: "172.19.0.1",
        headers: { "fly-client-ip": "198.51.100.10", "x-forwarded-for": `192.0.2.${i + 1}` },
      });
      assert.equal(response.statusCode, i < 50 ? 401 : 429);
    }
    assert.equal((await app.inject({
      method: "POST", url: "/runs/submit", remoteAddress: "172.19.0.1",
      headers: { "fly-client-ip": "198.51.100.11" },
    })).statusCode, 401);
    for (let i = 0; i < 51; i++) {
      const response = await app.inject({
        method: "POST", url: "/runs/submit", remoteAddress: "fdaa:f5:f6f5::1",
        headers: { "fly-client-ip": `198.51.100.${i + 1}`, "x-forwarded-for": `192.0.2.${i + 1}` },
      });
      assert.equal(response.statusCode, i < 50 ? 401 : 429);
    }
  } finally {
    if (previousApp === undefined) delete process.env["FLY_APP_NAME"];
    else process.env["FLY_APP_NAME"] = previousApp;
    await app.close();
  }
});

test("stream opening has a separate 300/minute budget and still requires authentication", async () => {
  const { app } = await createApp();
  try {
    assert.equal((await app.inject({ url: "/runs/example/stream", remoteAddress: "192.0.2.5" })).statusCode, 401);
    const options = { url: "/runs/example/stream", headers: { authorization: "Bearer test-token" } };
    for (let i = 0; i < 300; i++) {
      const response = await app.inject(options);
      assert.equal(response.statusCode, 404);
      assert.equal(response.headers["x-ratelimit-limit"], "300");
    }
    assert.equal((await app.inject(options)).statusCode, 429);
    for (let i = 0; i < 50; i++) assert.equal((await app.inject({ method: "POST", url: "/runs/submit" })).statusCode, 401);
  } finally { await app.close(); }
});

test("recording pages and audio have separate bounded budgets and still reject invalid tokens", async () => {
  const { app } = await createApp();
  try {
    for (const [url, limit] of [["/recordings/invalid", 120], ["/recordings/invalid/audio", 600]] as const) {
      const options = { url, headers: { range: "bytes=0-1023" } };
      for (let i = 0; i < limit; i++) {
        const response = await app.inject(options);
        assert.equal(response.statusCode, 404);
        assert.equal(response.headers["x-ratelimit-limit"], String(limit));
      }
      assert.equal((await app.inject(options)).statusCode, 429);
    }
    for (let i = 0; i < 50; i++) assert.equal((await app.inject({ method: "POST", url: "/runs/submit" })).statusCode, 401);
  } finally { await app.close(); }
});
