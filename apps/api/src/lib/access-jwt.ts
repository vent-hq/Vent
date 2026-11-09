import { z } from "zod";
import { requireEnv } from "@vent/shared";
import { createPublicKey } from "node:crypto";

const ACCESS_JWT_TTL_SECONDS = 15 * 60;
const ACCESS_JWT_ISSUER = "vent";
const ACCESS_JWT_AUDIENCE = "vent-api";

const identitySchema = z.object({
  userId: z.string().refine(value => value.trim().length > 0),
  accessTokenId: z.string().uuid(),
});

export interface AccessIdentity {
  userId: string;
  accessTokenId: string;
}

export interface AccessJwt {
  sign(identity: AccessIdentity): Promise<string>;
  verify(token: string): Promise<AccessIdentity>;
}

export async function createAccessJwt(): Promise<AccessJwt> {
  const { SignJWT, importPKCS8, importSPKI, jwtVerify } = await import("jose");
  const privatePem = requireEnv("JWT_PRIVATE_KEY");
  const publicKeyObject = createPublicKey(privatePem);
  if (publicKeyObject.asymmetricKeyType !== "rsa" || (publicKeyObject.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw new Error("JWT_PRIVATE_KEY must be an RSA private key with at least 2048 bits");
  }
  const [privateKey, publicKey] = await Promise.all([
    importPKCS8(privatePem, "RS256"),
    importSPKI(publicKeyObject.export({ type: "spki", format: "pem" }).toString(), "RS256"),
  ]);

  return {
    async sign(input) {
      const { userId, accessTokenId } = identitySchema.parse(input);
      const issuedAt = Math.floor(Date.now() / 1000);
      return new SignJWT({ access_token_id: accessTokenId })
        .setProtectedHeader({ alg: "RS256", typ: "at+jwt" })
        .setIssuer(ACCESS_JWT_ISSUER)
        .setAudience(ACCESS_JWT_AUDIENCE)
        .setSubject(userId)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + ACCESS_JWT_TTL_SECONDS)
        .sign(privateKey);
    },
    async verify(token) {
      const { payload } = await jwtVerify(token, publicKey, {
        algorithms: ["RS256"],
        typ: "at+jwt",
        issuer: ACCESS_JWT_ISSUER,
        audience: ACCESS_JWT_AUDIENCE,
        requiredClaims: ["sub", "access_token_id", "iat", "exp"],
        maxTokenAge: ACCESS_JWT_TTL_SECONDS,
      });
      return identitySchema.parse({ userId: payload.sub, accessTokenId: payload.access_token_id });
    },
  };
}
