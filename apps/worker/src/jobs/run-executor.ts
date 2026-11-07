import { eq } from "drizzle-orm";
import IORedis from "ioredis";
import { createDb, schema, type Database } from "@vent/db";
import {
  FLEET_ACTIVE_RUNS_KEY,
  formatConversationResult,
  signCallback,
  requireEnv,
} from "@vent/shared";

// Build headers + raw body for an HMAC-signed POST to /internal/* on the API.
// Returns the same body string that was signed so the caller can pass it as
// `body:` to fetch (signature is over the exact bytes the API will verify).
function signedJsonRequest(
  payload: unknown,
  secret: string,
): { headers: Record<string, string>; body: string } {
  const body = JSON.stringify(payload);
  return {
    headers: {
      "Content-Type": "application/json",
      ...signCallback(body, secret),
    },
    body,
  };
}

// POST with bounded retry. The runner-callback is the worker→API handoff
// that finalizes a run; a transient blip on a single fetch leaves the run
// stuck in "running" until the 60-min cleanup. Retries with exponential
// backoff and re-signs each attempt (timestamp must be fresh per request,
// otherwise the API rejects via verifyCallback's stale-timestamp check).
async function postSignedWithRetry(
  url: string,
  payload: unknown,
  secret: string,
  perAttemptTimeoutMs: number,
  attempts: number,
): Promise<Response> {
  let lastErr: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      const backoff = Math.min(2_000 * 2 ** (i - 1), 8_000);
      await new Promise((r) => setTimeout(r, backoff));
    }
    try {
      const signed = signedJsonRequest(payload, secret);
      const res = await fetch(url, {
        method: "POST",
        headers: signed.headers,
        body: signed.body,
        signal: AbortSignal.timeout(perAttemptTimeoutMs),
      });
      // Success or 4xx (won't get better with retry — stop now).
      if (res.ok) return res;
      if (res.status >= 400 && res.status < 500) return res;
      lastErr = new Error(`HTTP ${res.status} ${await res.text().catch(() => "")}`);
      console.warn(`[callback-retry] attempt ${i + 1}/${attempts} got ${res.status}`);
    } catch (err) {
      lastErr = err as Error;
      console.warn(`[callback-retry] attempt ${i + 1}/${attempts} error: ${lastErr.message}`);
    }
  }
  throw lastErr ?? new Error("callback failed");
}
import type {
  CallSpec,
  AdapterType,
} from "@vent/shared";
import type { AudioChannelConfig } from "@vent/adapters";
import { loadRunPlatformConfig } from "./platform-config.js";
import { executeCall } from "@vent/runner/executor";

// ---------------------------------------------------------------------------
// Event emission — writes to DB and notifies API for SSE broadcast
// ---------------------------------------------------------------------------

async function emitEvent(
  _db: Database,
  runId: string,
  eventType: string,
  message: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    // POST to API — it handles both DB write and SSE broadcast.
    // (Don't write to DB here too, or events get duplicated.)
    const apiUrl = process.env["API_URL"]!;
    const secret = process.env["RUNNER_CALLBACK_SECRET"] ?? "";
    const signed = signedJsonRequest(
      { run_id: runId, event_type: eventType, message, metadata_json: metadata },
      secret,
    );
    await fetch(`${apiUrl}/internal/run-event`, {
      method: "POST",
      headers: signed.headers,
      body: signed.body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Best-effort — don't fail the run if event emission fails
  }
}

interface RunJob {
  run_id: string;
  user_id: string;
  adapter?: string;
  call_spec?: Record<string, unknown>;
  voice_config?: Record<string, unknown>;
  start_command?: string;
  health_endpoint?: string;
  agent_url?: string;
  agent_session_id?: string;
}

const redisUrl = requireEnv("REDIS_URL");
const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });

// ---------------------------------------------------------------------------
// Direct execution for already-deployed agents (platform adapters or agent_url)
// ---------------------------------------------------------------------------

async function executeRemoteRun(
  db: Database,
  job: RunJob,
  signal: AbortSignal,
): Promise<void> {
  const apiUrl = process.env["API_URL"]!;
  const callbackSecret = process.env["RUNNER_CALLBACK_SECRET"] ?? "";
  const callbackUrl = `${apiUrl}/internal/runner-callback`;

  const adapterType = (job.adapter ?? "websocket") as AdapterType;
  const agentUrl = job.agent_url ?? "http://localhost:3001";
  const platform = await loadRunPlatformConfig(db, job.run_id, job.user_id, adapterType);
  const callSpec = (job.call_spec as unknown as CallSpec).call;

  const channelConfig: AudioChannelConfig = {
    adapter: adapterType,
    agentUrl,
    platform,
  };

  // No try/catch here — let errors propagate to executeRun's outer catch,
  // which is the single source of truth for cleanup (SREM + DB UPDATE).
  // Earlier code had cleanup at this layer AND the outer layer; that
  // overwrote the more-specific inner error_text with a generic outer one
  // and emitted two [fleet-cap] log lines per failure.
  const { status, conversationResult, aggregate } = await executeCall({
    runId: job.run_id,
    userId: job.user_id,
    callSpec,
    channelConfig,
    signal,
    onCallComplete: async (result) => {
      const callName = result.name ?? "conversation";
      try {
        const signed = signedJsonRequest(
          {
            run_id: job.run_id,
            completed: 1,
            total: 1,
            call_type: "conversation",
            call_name: callName,
            status: result.status,
            duration_ms: result.duration_ms,
            result: formatConversationResult(result),
          },
          callbackSecret,
        );
        const res = await fetch(`${apiUrl}/internal/call-progress`, {
          method: "POST",
          headers: signed.headers,
          body: signed.body,
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) console.warn(`call-progress POST failed (${res.status}) for ${callName}`);
      } catch (err) {
        console.warn(`call-progress POST error for ${callName}:`, (err as Error).message);
      }
    },
  });

  const response = await postSignedWithRetry(
    callbackUrl,
    {
      run_id: job.run_id,
      status,
      conversation_result: conversationResult,
      aggregate,
    },
    callbackSecret,
    30_000,
    4,
  );

  if (!response.ok) {
    throw new Error(`Callback failed: ${response.status} ${await response.text()}`);
  }

  console.log(`Remote run ${job.run_id} completed: ${status}`);
}

// ---------------------------------------------------------------------------
// Relay execution — calls run in worker, audio flows through relay to local agent
// ---------------------------------------------------------------------------

async function executeSessionRun(
  db: Database,
  job: RunJob,
  relayMachineId: string,
  signal: AbortSignal,
): Promise<void> {
  const apiUrl = process.env["API_URL"]!;
  const callbackSecret = process.env["RUNNER_CALLBACK_SECRET"] ?? "";
  const callbackUrl = `${apiUrl}/internal/runner-callback`;

  // Build relay connect URL using session_id — the WsAudioChannel will append conn_id automatically
  const relayWsUrl = apiUrl.replace(/^http/, "ws") + `/relay/connect?session_id=${job.agent_session_id}`;

  // Pin all relay connections to the API machine that holds the relay session.
  // Without this, Fly.io load-balances across machines and connections hit
  // instances that have no in-memory session → 4404 → "WebSocket not connected".
  const relayHeaders: Record<string, string> = {};
  if (relayMachineId && relayMachineId !== "local") {
    relayHeaders["fly-force-instance-id"] = relayMachineId;
    console.log(`[relay] Pinning connections to Fly machine ${relayMachineId}`);
  }

  const channelConfig: AudioChannelConfig = {
    adapter: "websocket",
    agentUrl: relayWsUrl,
    relayHeaders,
  };

  const callSpec = (job.call_spec as unknown as CallSpec).call;

  // Same as executeRemoteRun: no inner try/catch — let errors bubble to
  // executeRun's outer catch (single cleanup point).
  const { status, conversationResult, aggregate } = await executeCall({
    runId: job.run_id,
    userId: job.user_id,
    callSpec,
    channelConfig,
    signal,
    onCallComplete: async (result) => {
      const callName = result.name ?? "conversation";
      try {
        const signed = signedJsonRequest(
          {
            run_id: job.run_id,
            completed: 1,
            total: 1,
            call_type: "conversation",
            call_name: callName,
            status: result.status,
            duration_ms: result.duration_ms,
            result: formatConversationResult(result),
          },
          callbackSecret,
        );
        const res = await fetch(`${apiUrl}/internal/call-progress`, {
          method: "POST",
          headers: signed.headers,
          body: signed.body,
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) console.warn(`call-progress POST failed (${res.status}) for ${callName}`);
      } catch (err) {
        console.warn(`call-progress POST error for ${callName}:`, (err as Error).message);
      }
    },
  });

  const response = await postSignedWithRetry(
    callbackUrl,
    {
      run_id: job.run_id,
      status,
      conversation_result: conversationResult,
      aggregate,
    },
    callbackSecret,
    30_000,
    4,
  );

  if (!response.ok) {
    throw new Error(`Callback failed: ${response.status} ${await response.text()}`);
  }

  console.log(`Session run ${job.run_id} completed: ${status}`);
}

// ---------------------------------------------------------------------------
// Module-level DB — single connection pool shared across all jobs
// ---------------------------------------------------------------------------
// Pool size scales with WORKER_TOTAL_CONCURRENCY (each in-flight job issues
// several queries during its lifetime — status updates, encrypted-creds
// resolve, etc.). Override with WORKER_DB_POOL_MAX for fatter workers.

function parsePoolMax(): number {
  const explicit = process.env["WORKER_DB_POOL_MAX"];
  if (explicit) {
    const n = Number.parseInt(explicit, 10);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error("WORKER_DB_POOL_MAX must be a positive integer");
    }
    return n;
  }
  // Default formula: ~2x concurrency, capped at 50 per worker process.
  // Multiple worker machines × default formula could otherwise exhaust the
  // shared Postgres `max_connections` budget. Operators can override with
  // WORKER_DB_POOL_MAX after sizing their DB tier.
  const conc = Number.parseInt(process.env["WORKER_TOTAL_CONCURRENCY"] ?? "10", 10);
  return Math.min(50, Math.max(10, conc * 2));
}

const db = createDb(requireEnv("DATABASE_URL"), {
  max: parsePoolMax(),
  idleTimeoutSeconds: 30,
  maxLifetimeSeconds: 3600,
});

// ---------------------------------------------------------------------------
// Look up relay session machine from Redis (session is already connected)
// ---------------------------------------------------------------------------

async function getSessionMachineId(sessionId: string): Promise<string> {
  const key = `vent:relay-session:${sessionId}`;

  const machineId = await redis.get(key);
  if (!machineId) {
    throw new Error(`Agent session ${sessionId} relay not found in Redis — is the tunnel still connected?`);
  }
  return machineId;
}

async function isRunCancelled(runId: string): Promise<boolean> {
  const cancelled = await redis.get(`vent:cancelled:${runId}`);
  return cancelled === "1";
}

// How often the worker polls Redis for the cancellation flag while a call is
// in flight. The runner checks the AbortSignal at every turn boundary, so the
// effective worst-case lag from `vent-hq stop` to channel hangup is one turn
// (≤30s) plus this interval.
const CANCEL_POLL_INTERVAL_MS = 2_000;

// ---------------------------------------------------------------------------
// Main run executor
// ---------------------------------------------------------------------------

export async function executeRun(job: RunJob): Promise<void> {
  // Per-run cancel signal. The poller below trips it when `vent-hq stop`
  // sets `vent:cancelled:<id>` in Redis (see apps/api/src/routes/runs.ts).
  // The runner checks `signal.aborted` at every turn boundary, throws,
  // preserves partial transcript, and hangs up the platform call.
  const cancelController = new AbortController();
  // Declared outside the try so the finally always sees it; assigned inside
  // so a synchronous throw before scheduling doesn't leak a phantom interval.
  let cancelPoller: ReturnType<typeof setInterval> | null = null;

  try {
    cancelPoller = setInterval(() => {
      isRunCancelled(job.run_id)
        .then((cancelled) => {
          if (cancelled && !cancelController.signal.aborted) {
            console.log(`[cancel] Run ${job.run_id} flagged cancelled — aborting in-flight call`);
            cancelController.abort();
          }
        })
        .catch(() => {});
    }, CANCEL_POLL_INTERVAL_MS);

    if (await isRunCancelled(job.run_id)) {
      console.log(`Run ${job.run_id} cancelled before start`);
      const removed = await redis.srem(FLEET_ACTIVE_RUNS_KEY, job.run_id).catch(() => 0);
      const active = await redis.scard(FLEET_ACTIVE_RUNS_KEY).catch(() => -1);
      console.log(`[fleet-cap] SREM cancelled-before-start run=${job.run_id} removed=${removed} active=${active}`);
      return;
    }

    await db
      .update(schema.runs)
      .set({ status: "running", started_at: new Date() })
      .where(eq(schema.runs.id, job.run_id));

    await emitEvent(db, job.run_id, "run_started", "Run started");

    // Already-deployed agents: run calls directly in worker process
    const isPlatformAdapter =
      job.adapter === "vapi" ||
      job.adapter === "retell" ||
      job.adapter === "elevenlabs" ||
      job.adapter === "bland" ||
      job.adapter === "livekit";
    const isRemote =
      isPlatformAdapter ||
      !!job.agent_url;
    if (isRemote) {
      await emitEvent(db, job.run_id, "connecting", `Connecting to remote agent (${job.adapter ?? "websocket"})...`);
      await executeRemoteRun(db, job, cancelController.signal);
      return;
    }

    // Local agent via agent session relay. Throw rather than return: BullMQ
    // tracks failure on thrown errors only — a silent return marks the job
    // "completed" even though the DB row says fail, hiding failures from
    // worker.on('failed') metrics. The outer catch handles cleanup.
    if (!job.agent_session_id) {
      throw new Error("Missing agent_session_id for local run");
    }

    await emitEvent(db, job.run_id, "connecting", "Connecting to local agent via session relay...");

    const machineId = await getSessionMachineId(job.agent_session_id);

    await executeSessionRun(db, job, machineId, cancelController.signal);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    console.error(`Failed to start run ${job.run_id}:`, errorMessage);
    // SREM and DB update are idempotent — safe to repeat if an inner
    // executor already cleaned up before throwing.
    const removed = await redis.srem(FLEET_ACTIVE_RUNS_KEY, job.run_id).catch(() => 0);
    const active = await redis.scard(FLEET_ACTIVE_RUNS_KEY).catch(() => -1);
    console.log(`[fleet-cap] SREM outer-catch run=${job.run_id} removed=${removed} active=${active}`);
    await db
      .update(schema.runs)
      .set({ status: "fail", finished_at: new Date(), error_text: errorMessage })
      .where(eq(schema.runs.id, job.run_id));

    throw err;
  } finally {
    if (cancelPoller) clearInterval(cancelPoller);
  }
}
