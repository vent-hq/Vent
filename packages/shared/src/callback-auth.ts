import { createHmac, timingSafeEqual } from "node:crypto";
import {
  RUNNER_CALLBACK_MAX_SKEW_MS,
  RUNNER_CALLBACK_SIGNATURE_HEADER,
  RUNNER_CALLBACK_TIMESTAMP_HEADER,
} from "./constants.js";

export interface CallbackHeaders {
  [RUNNER_CALLBACK_SIGNATURE_HEADER]: string;
  [RUNNER_CALLBACK_TIMESTAMP_HEADER]: string;
}

// Signs the method, path, timestamp and exact body bytes, one per line, so a
// signature is only valid for the endpoint it was made for and only while the
// timestamp is fresh.
function computeSignature(method: string, path: string, timestamp: string, rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(`${method}\n${path}\n${timestamp}\n${rawBody}`).digest("base64url");
}

export function signCallback(method: string, path: string, rawBody: string, secret: string): CallbackHeaders {
  const timestamp = String(Date.now());
  const signature = computeSignature(method, path, timestamp, rawBody, secret);
  return {
    [RUNNER_CALLBACK_SIGNATURE_HEADER]: signature,
    [RUNNER_CALLBACK_TIMESTAMP_HEADER]: timestamp,
  };
}

export type VerifyCallbackResult =
  | { ok: true }
  | { ok: false; reason: "missing_signature" | "missing_timestamp" | "stale_timestamp" | "bad_signature" };

export function verifyCallback(
  method: string,
  path: string,
  rawBody: string,
  secret: string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  nowMs: number = Date.now(),
): VerifyCallbackResult {
  if (!signatureHeader) return { ok: false, reason: "missing_signature" };
  if (!timestampHeader) return { ok: false, reason: "missing_timestamp" };

  const ts = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: "missing_timestamp" };
  if (Math.abs(nowMs - ts) > RUNNER_CALLBACK_MAX_SKEW_MS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const expected = computeSignature(method, path, timestampHeader, rawBody, secret);
  const provided = Buffer.from(signatureHeader);
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length || !timingSafeEqual(provided, expectedBuf)) {
    return { ok: false, reason: "bad_signature" };
  }

  return { ok: true };
}
