import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { schema } from "@vent/db";
import { authPlugin } from "../../src/plugins/auth.js";
import { keyRoutes } from "../../src/routes/keys.js";
import { deviceRoutes } from "../../src/routes/device.js";
import { agentAuthRoutes } from "../../src/routes/agent-auth.js";
import { createAccessJwt } from "../../src/lib/access-jwt.js";

const oldKey = process.env["JWT_PRIVATE_KEY"];
before(() => {
  process.env["JWT_PRIVATE_KEY"] = generateKeyPairSync("rsa", { modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
});
after(() => {
  if (oldKey === undefined) delete process.env["JWT_PRIVATE_KEY"];
  else process.env["JWT_PRIVATE_KEY"] = oldKey;
});

async function fixture() {
  const app = Fastify();
  const userId = "gh_issuer-test";
  const credentials: Record<string, unknown>[] = [];
  const refresh = `vent_${"ef".repeat(24)}`;
  const session = { id: randomUUID(), session_id: "device-secret", user_id: userId,
    access_token_id: randomUUID(), raw_access_token: refresh, consumed_at: null as Date | null,
    expires_at: new Date(Date.now() + 60_000) };
  const params = (where: SQL) => new PgDialect().sqlToQuery(where).params;
  const db = {
    insert: () => ({ values: (value: Record<string, unknown>) => ({ returning: async () => {
      const row = { id: randomUUID(), created_at: new Date(), revoked_at: null, ...value };
      credentials.push(row);
      return [row];
    } }) }),
    select: () => ({ from: (table: unknown) => ({ where: (where: SQL) => {
      const limit = async () => table === schema.deviceSessions
        ? params(where).includes(session.session_id) ? [{ ...session }] : []
        : credentials.filter(row => (params(where).includes(row.token_hash) || (params(where).includes(row.id) && params(where).includes(row.user_id))) && row.revoked_at === null);
      return { limit };
    } }) }),
    update: (table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: (where: SQL) => {
      if (table !== schema.deviceSessions) {
        const row = credentials.find(row => params(where).includes(row.id) && params(where).includes(row.user_id) && row.revoked_at === null);
        if (row) Object.assign(row, values);
        return { returning: async () => row ? [row] : [] };
      }
      return { returning: async () => {
        assert.match(new PgDialect().sqlToQuery(where).sql, /"consumed_at" is null/);
        if (session.consumed_at) return [];
        Object.assign(session, values);
        return [{ id: session.id }];
      } };
    } }) }),
  };
  app.decorate("db", db as unknown as FastifyInstance["db"]);
  await app.register(authPlugin);
  await app.register(keyRoutes);
  await app.register(deviceRoutes);
  await app.register(agentAuthRoutes);
  app.get("/identity", { preHandler: app.verifyAccessToken }, async request => ({ userId: request.userId }));
  const actorId = randomUUID();
  credentials.push({ id: actorId, user_id: userId, revoked_at: null, token_hash: "test-actor-hash" });
  const access = await app.issueAccessToken({ userId, accessTokenId: actorId });
  return { app, userId, credentials, session, headers: { authorization: `Bearer ${access}` } };
}

test("key creation stores a hashed credential that can renew access until revoked", async () => {
  const { app, userId, credentials, headers } = await fixture();
  try {
    const response = await app.inject({ method: "POST", url: "/keys", headers, payload: { name: "test-key" } });
    assert.equal(response.statusCode, 201);
    const key = response.json();
    assert.equal(key.access_token, undefined);
    const renewed = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refresh_token: key.refresh_token } });
    assert.equal(renewed.statusCode, 200);
    const pair = renewed.json();
    const service = await createAccessJwt();
    assert.deepEqual(await service.verify(pair.access_token), { userId, accessTokenId: key.id });
    assert.equal(credentials[1]!.token_hash, createHash("sha256").update(pair.refresh_token).digest("hex"));
    assert.notEqual(credentials[1]!.token_hash, pair.refresh_token);
    assert.equal((await app.inject({ method: "DELETE", url: `/keys/${key.id}`, headers })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refresh_token: pair.refresh_token } })).statusCode, 401);
    assert.equal((await app.inject({ url: "/identity", headers: { authorization: `Bearer ${pair.access_token}` } })).statusCode, 200);
    const revokedHeaders = { authorization: `Bearer ${pair.access_token}` };
    const countBefore = credentials.length;
    assert.equal((await app.inject({ method: "POST", url: "/keys", headers: revokedHeaders, payload: { name: "escape" } })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/device/approve", headers: revokedHeaders, payload: { user_code: "test-code" } })).statusCode, 401);
    assert.equal(credentials.length, countBefore);
  } finally { await app.close(); }
});

test("a device login hands out a JWT and refresh credential only once under concurrent polling", async () => {
  const { app, userId, credentials, session } = await fixture();
  const refreshToken = session.raw_access_token;
  credentials.push({ id: session.access_token_id, user_id: userId, revoked_at: null,
    token_hash: createHash("sha256").update(refreshToken).digest("hex") });
  try {
    const responses = await Promise.all([0, 1].map(() => app.inject({
      method: "POST", url: "/device/exchange", payload: { session_id: session.session_id },
    })));
    const bodies = responses.map(response => response.json());
    assert.deepEqual(bodies.map(body => body.status).sort(), ["approved", "consumed"]);
    const approved = bodies.find(body => body.status === "approved");
    assert.equal(approved.refresh_token, refreshToken);
    assert.deepEqual(await (await createAccessJwt()).verify(approved.access_token), { userId, accessTokenId: session.access_token_id });
    assert.equal(session.raw_access_token, null);
    assert.ok(session.consumed_at instanceof Date);
  } finally { await app.close(); }
});
