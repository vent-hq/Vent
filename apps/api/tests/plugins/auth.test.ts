import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, createHash } from "node:crypto";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { authPlugin } from "../../src/plugins/auth.js";
import { agentAuthRoutes } from "../../src/routes/agent-auth.js";

const previousKey = process.env["JWT_PRIVATE_KEY"];
const identity = { userId: "gh_123", accessTokenId: randomUUID() };
before(() => {
  process.env["JWT_PRIVATE_KEY"] = generateKeyPairSync("rsa", {
    modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
});
after(() => {
  if (previousKey === undefined) delete process.env["JWT_PRIVATE_KEY"];
  else process.env["JWT_PRIVATE_KEY"] = previousKey;
});

test("valid, forged, missing, and opaque bearer tokens never trigger an authentication DB lookup", async () => {
  const app = Fastify();
  let reads = 0;
  app.decorate("db", { select() { reads++; throw new Error("Unexpected authentication DB lookup"); } } as unknown as FastifyInstance["db"]);
  await app.register(authPlugin);
  app.get("/identity", { preHandler: app.verifyAccessToken }, async request => ({
    userId: request.userId, accessTokenId: request.accessTokenId,
  }));
  app.get("/either-auth", { preHandler: app.verifyAuth }, async request => ({ userId: request.userId }));
  try {
    const token = await app.issueAccessToken(identity);
    const valid = await app.inject({ url: "/identity", headers: { authorization: `Bearer ${token}` } });
    assert.equal(valid.statusCode, 200);
    assert.deepEqual(valid.json(), identity);
    assert.equal((await app.inject({ url: "/either-auth", headers: { authorization: `Bearer ${token}` } })).statusCode, 200);
    const parts = token.split(".");
    parts[1] = Buffer.from(JSON.stringify({ sub: "attacker", access_token_id: randomUUID() })).toString("base64url");
    for (const authorization of [undefined, "Bearer ", "Bearer fake", `Bearer ${parts.join(".")}`, `Bearer vent_${"ab".repeat(24)}`]) {
      assert.equal((await app.inject({ url: "/identity", headers: authorization ? { authorization } : {} })).statusCode, 401);
    }
    assert.equal(reads, 0);
  } finally { await app.close(); }
});

test("only credential renewal looks up the refresh hash, and revoked credentials cannot renew", async () => {
  const app = Fastify();
  const refresh = `vent_${"ab".repeat(24)}`;
  const hash = createHash("sha256").update(refresh).digest("hex");
  let reads = 0;
  let revoked = false;
  const db = { select: () => ({ from: () => ({ where: (where: SQL) => ({ limit: async () => {
    reads++;
    const query = new PgDialect().sqlToQuery(where);
    assert.match(query.sql, /"revoked_at" is null/);
    return query.params.includes(hash) && !revoked ? [{ id: identity.accessTokenId, user_id: identity.userId }] : [];
  } }) }) }) };
  app.decorate("db", db as unknown as FastifyInstance["db"]);
  await app.register(authPlugin);
  await app.register(agentAuthRoutes);
  try {
    assert.equal((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refresh_token: "wrong" } })).statusCode, 400);
    assert.equal(reads, 0);
    const response = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refresh_token: refresh } });
    assert.equal(response.statusCode, 200);
    const pair = response.json();
    assert.deepEqual(Object.keys(pair).sort(), ["access_token", "refresh_token"]);
    const { createAccessJwt } = await import("../../src/lib/access-jwt.js");
    assert.deepEqual(await (await createAccessJwt()).verify(pair.access_token), identity);
    assert.equal(pair.refresh_token, refresh);
    revoked = true;
    assert.equal((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refresh_token: refresh } })).statusCode, 401);
    assert.equal(reads, 2);
  } finally { await app.close(); }
});
