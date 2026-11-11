import { createHmac } from "node:crypto";
import { requireEnv, safeEqual } from "@vent/shared";
import { S3Storage } from "./s3.js";

// v=2 adds `uid` (owning user) and `exp` (unix seconds) so recording URLs are
// scoped to a user and expire. v=1 tokens are no longer issued and rejected
// on verify (they had no expiry / no user binding).
interface ArtifactTokenPayloadV2 {
  v: 2;
  k: string;
  uid: string;
  exp: number;
}

// 1 hour — short enough that a leaked URL goes dead quickly, long enough for
// a user to click through from their coding agent and listen comfortably.
// The token itself is the credential (S3 / Twilio pattern); we deliberately
// don't require session auth on the recording route because the cookie can't
// cross the dashboard↔api origin boundary on .fly.dev.
const TOKEN_TTL_SECONDS = 60 * 60;

function signToken(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export interface CreateArtifactTokenOpts {
  userId: string;
}

export function createArtifactToken(
  key: string,
  secret: string,
  opts: CreateArtifactTokenOpts,
): string {
  const payload: ArtifactTokenPayloadV2 = {
    v: 2,
    k: key,
    uid: opts.userId,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${signToken(encodedPayload, secret)}`;
}

export interface VerifiedArtifactToken {
  key: string;
  userId: string;
  expiresAt: number;
}

export function verifyArtifactToken(token: string, secret: string): VerifiedArtifactToken | null {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;
  if (!safeEqual(signature, signToken(encodedPayload, secret))) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<ArtifactTokenPayloadV2>;
    if (
      payload.v !== 2 ||
      typeof payload.k !== "string" ||
      payload.k.length === 0 ||
      typeof payload.uid !== "string" ||
      payload.uid.length === 0 ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    if (payload.exp * 1000 < Date.now()) {
      return null;
    }
    return { key: payload.k, userId: payload.uid, expiresAt: payload.exp * 1000 };
  } catch {
    return null;
  }
}

export function buildArtifactUrl(baseUrl: string, token: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  return `${normalizedBase}/recordings/${encodeURIComponent(token)}`;
}

export function createStorageClient(): S3Storage {
  return new S3Storage({
    endpoint: requireEnv("S3_ENDPOINT"),
    bucket: requireEnv("S3_BUCKET"),
    accessKeyId: process.env["S3_ACCESS_KEY_ID"] ?? "",
    secretAccessKey: process.env["S3_SECRET_ACCESS_KEY"] ?? "",
    region: process.env["S3_REGION"] ?? "auto",
  });
}
