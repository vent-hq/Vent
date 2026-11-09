export const DEFAULT_HEALTH_TIMEOUT_MS = 60_000; // 1 minute
export const DEFAULT_HEALTH_INTERVAL_MS = 2_000;
export const DEFAULT_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_AGENT_PORT = 3001;
export const DEFAULT_API_PORT = 3000;

// Plaintext-secret header for the worker's relay WebSocket (no body to sign).
// POST callbacks use the HMAC headers below.
export const RUNNER_CALLBACK_HEADER = "x-runner-secret";

// HMAC-signed callback headers (for POST /internal/* routes).
// Signature = HMAC-SHA256(secret, `${method}\n${path}\n${timestamp}\n${rawBody}`), base64url.
// Timestamp is unix milliseconds; reject if drift > RUNNER_CALLBACK_MAX_SKEW_MS.
export const RUNNER_CALLBACK_SIGNATURE_HEADER = "x-vent-signature";
export const RUNNER_CALLBACK_TIMESTAMP_HEADER = "x-vent-timestamp";
export const RUNNER_CALLBACK_MAX_SKEW_MS = 5 * 60_000;

export const RUN_QUEUE_NAME = "vent-runs";
// A 60 s lock lets a call survive a ~45 s Redis blip.
export const RUN_JOB_LOCK_DURATION_MS = 60_000;
export const RUN_JOB_LOCK_RENEW_MS = 15_000;
export const RUN_JOB_STALLED_INTERVAL_MS = 5_000;

// Caller voice accents (caller_audio.accent). Each maps to a Deepgram Aura-2
// voice in packages/voice; the non-English ones are voices in that language.
export const CALLER_ACCENTS = [
  "american",
  "british",
  "australian",
  "filipino",
  "spanish_mexican",
  "spanish_peninsular",
  "spanish_colombian",
  "spanish_argentine",
  "german",
  "french",
  "italian",
  "dutch",
  "japanese",
] as const;
export type CallerAccent = (typeof CALLER_ACCENTS)[number];
