import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import {
  createAccessJwt,
  type AccessJwt,
} from "../../src/lib/access-jwt.js";

const previousPrivate = process.env["JWT_PRIVATE_KEY"];
let privatePem: string;
let otherPrivate: string;
let service: AccessJwt;
const identity = { userId: "gh_123", accessTokenId: randomUUID() };

function generatePair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
}

before(async () => {
  ({ privateKey: privatePem } = generatePair());
  ({ privateKey: otherPrivate } = generatePair());
  process.env["JWT_PRIVATE_KEY"] = privatePem;
  service = await createAccessJwt();
});

after(() => {
  if (previousPrivate === undefined) delete process.env["JWT_PRIVATE_KEY"];
  else process.env["JWT_PRIVATE_KEY"] = previousPrivate;
});

async function makeToken(
  changes: Record<string, unknown> = {},
  header: { alg: string; typ?: string } = { alg: "RS256", typ: "at+jwt" },
  pem = privatePem,
) {
  const { SignJWT, importPKCS8 } = await import("jose");
  const now = Math.floor(Date.now() / 1000);
  const key = header.alg === "HS256" ? new Uint8Array(32) : await importPKCS8(pem, header.alg);
  return new SignJWT({
    sub: identity.userId, access_token_id: identity.accessTokenId,
    iss: "vent", aud: "vent-api",
    iat: now, exp: now + 900,
    ...changes,
  }).setProtectedHeader(header).sign(key);
}

test("issues RS256 access JWTs for GitHub and WorkOS identities, expiring in exactly 15 minutes", async () => {
  const { decodeJwt, decodeProtectedHeader } = await import("jose");
  for (const userId of ["gh_123", "user_01WORKOS"]) {
    const token = await service.sign({ ...identity, userId });
    assert.deepEqual(decodeProtectedHeader(token), { alg: "RS256", typ: "at+jwt" });
    const claims = decodeJwt(token);
    assert.equal(claims.iss, "vent");
    assert.equal(claims.aud, "vent-api");
    assert.equal(claims.exp! - claims.iat!, 900);
    assert.deepEqual(await service.verify(token), { ...identity, userId });
  }
});

test("rejects a changed payload, a different signing key, and unsigned tokens", async () => {
  const { decodeJwt, UnsecuredJWT } = await import("jose");
  const token = await service.sign(identity);
  const parts = token.split(".");
  parts[1] = Buffer.from(JSON.stringify({ ...decodeJwt(token), sub: "attacker" })).toString("base64url");
  await assert.rejects(service.verify(parts.join(".")));
  await assert.rejects(service.verify(await makeToken({}, undefined, otherPrivate)));
  await assert.rejects(service.verify(new UnsecuredJWT(decodeJwt(token)).encode()));
});

test("rejects the wrong algorithm, issuer, audience, or token type", async () => {
  for (const header of [{ alg: "HS256", typ: "at+jwt" }, { alg: "RS384", typ: "at+jwt" },
    { alg: "RS256", typ: "JWT" }, { alg: "RS256" }]) {
    await assert.rejects(service.verify(await makeToken({}, header)));
  }
  for (const changes of [{ iss: "another-service" }, { aud: "another-api" }]) {
    await assert.rejects(service.verify(await makeToken(changes)));
  }
});

test("rejects missing or invalid identity and required time claims", async () => {
  for (const claim of ["sub", "access_token_id", "iat", "exp", "iss", "aud"]) {
    await assert.rejects(service.verify(await makeToken({ [claim]: undefined })));
  }
  for (const changes of [{ sub: "" }, { sub: "   " }, { sub: 123 }, { access_token_id: "not-a-uuid" },
    { access_token_id: 123 }, { exp: "tomorrow" }, { iat: "yesterday" }]) {
    await assert.rejects(service.verify(await makeToken(changes)));
  }
});

test("rejects expired tokens, future activation, future issue time, and tokens older than 15 minutes", async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const changes of [{ exp: now - 1 }, { nbf: now + 60 }, { iat: now + 60 },
    { iat: now - 901, exp: now + 60 }]) {
    await assert.rejects(service.verify(await makeToken(changes)));
  }
});

test("retains imported keys after environment changes", async () => {
  try {
    delete process.env["JWT_PRIVATE_KEY"];
    assert.deepEqual(await service.verify(await service.sign(identity)), identity);
  } finally {
    process.env["JWT_PRIVATE_KEY"] = privatePem;
  }
});

test("missing, invalid, non-RSA, or weak keys fail during service creation", async () => {
  try {
    delete process.env["JWT_PRIVATE_KEY"];
    await assert.rejects(createAccessJwt());
    for (const key of ["invalid-key", generateKeyPairSync("ec", { namedCurve: "P-256",
      privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey, generateKeyPairSync("rsa", { modulusLength: 1024,
      privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey]) {
      process.env["JWT_PRIVATE_KEY"] = key;
      await assert.rejects(createAccessJwt());
    }
  } finally {
    process.env["JWT_PRIVATE_KEY"] = privatePem;
  }
});
