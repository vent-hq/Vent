import { and, eq, sql } from "drizzle-orm";
import IORedis from "ioredis";
import { createDb, schema, type Database } from "@vent/db";
import {
  envPositiveInt,
  signCallback,
  RUNNER_CALLBACK_HEADER,
  requireEnv,
  type RunJob,
  type WorkerCallbackBodies,
  isPlatformProvider,
} from "@vent/shared";
import type { AudioChannelConfig } from "@vent/adapters";
import { loadRunPlatformConfig } from "./platform-config.js";
import { CALL_PROCESS_ENTRY, runCallInProcess } from "../call-supervisor.js";

const apiUrl = requireEnv("API_URL");
const callbackSecret = requireEnv("RUNNER_CALLBACK_SECRET");

// Signed POST to the API's /internal/* routes. The signature covers the
// method, path, timestamp and exact body (packages/shared/src/callback-auth.ts),
// so it is re-made for every attempt and only valid for this path.
function postToApi<P extends keyof WorkerCallbackBodies>(
  path: P,
  payload: WorkerCallbackBodies[P],
  timeoutMs: number,
): Promise<Response> {
  const body = JSON.stringify(payload);
  return fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...signCallback("POST", path, body, callbackSecret),
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// POST with bounded retry, for reports that end a run: a transient blip on a
// single fetch would otherwise leave the run "running" until the cleanup job.
async function postToApiWithRetry<P extends keyof WorkerCallbackBodies>(
  path: P,
  payload: WorkerCallbackBodies[P],
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
      const res = await postToApi(path, payload, perAttemptTimeoutMs);
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

// ---------------------------------------------------------------------------
// Event emission — writes to DB and notifies API for SSE broadcast
// ---------------------------------------------------------------------------

async function emitEvent(
  runId: string,
  eventType: string,
  message: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  // The API writes the event and broadcasts it to the CLI's stream.
  // Best-effort: a lost event doesn't fail the run.
  await postToApi(
    "/internal/run-event",
    { run_id: runId, event_type: eventType, message, metadata_json: metadata },
    10_000,
  ).catch(() => {});
}

export class LostCallLock extends Error {
  constructor() {
    super("Vent failed, agent not tested: the worker lost its Redis connection mid-call");
  }
}

const redisUrl = requireEnv("REDIS_URL");
const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });

// ---------------------------------------------------------------------------
// Direct execution for already-deployed agents (platform adapters or agent_url)
// ---------------------------------------------------------------------------

// Runs the call in its own process, then reports the result, which ends the run.
async function runCallAndReport(
  job: RunJob,
  channelConfig: AudioChannelConfig,
  signal: AbortSignal,
): Promise<void> {
  // No try/catch here — errors (including a crashed or killed call process)
  // propagate to executeRun's outer catch, which reports them to the API.
  const { status, conversationResult } = await runCallInProcess(CALL_PROCESS_ENTRY, {
    runId: job.run_id,
    userId: job.user_id,
    callSpec: job.call_spec.call,
    channelConfig,
  }, { signal });
  if (signal.reason instanceof LostCallLock) throw signal.reason;

  const response = await postToApiWithRetry("/internal/runner-callback", {
    run_id: job.run_id,
    status: signal.aborted ? "cancelled" : status,
    conversation_result: conversationResult,
    ...(signal.aborted ? { error_text: "Cancelled by user" } : {}),
  }, 30_000, 4);

  if (!response.ok) {
    throw new Error(`Callback failed: ${response.status} ${await response.text()}`);
  }

  console.log(`Run ${job.run_id} completed: ${status}`);
}

// ---------------------------------------------------------------------------
// Direct execution for already-deployed agents (platform adapters or agent_url)
// ---------------------------------------------------------------------------

async function executeRemoteRun(
  db: Database,
  job: RunJob,
  signal: AbortSignal,
): Promise<void> {
  const platform = await loadRunPlatformConfig(db, job.run_id, job.user_id, job.adapter);
  await runCallAndReport(job, {
    adapter: job.adapter,
    agentUrl: job.agent_url,
    platform,
  }, signal);
}

// ---------------------------------------------------------------------------
// Relay execution — calls run in worker, audio flows through relay to local agent
// ---------------------------------------------------------------------------

async function executeSessionRun(
  job: RunJob,
  relayMachineId: string,
  signal: AbortSignal,
): Promise<void> {
  // Build relay connect URL using session_id — the WsAudioChannel will append conn_id automatically
  const relayWsUrl = apiUrl.replace(/^http/, "ws") + `/relay/connect?session_id=${job.agent_session_id}`;

  // Pin all relay connections to the API machine that holds the relay session.
  // Without this, Fly.io load-balances across machines and connections hit
  // instances that have no in-memory session → 4404 → "WebSocket not connected".
  const relayHeaders: Record<string, string> = { [RUNNER_CALLBACK_HEADER]: callbackSecret };
  if (relayMachineId && relayMachineId !== "local") {
    relayHeaders["fly-force-instance-id"] = relayMachineId;
    console.log(`[relay] Pinning connections to Fly machine ${relayMachineId}`);
  }

  await runCallAndReport(job, {
    adapter: "websocket",
    agentUrl: relayWsUrl,
    relayHeaders,
  }, signal);
}

// ---------------------------------------------------------------------------
// Module-level DB — single connection pool shared across all jobs
// ---------------------------------------------------------------------------
// Pool size scales with WORKER_TOTAL_CONCURRENCY (each in-flight job issues
// several queries during its lifetime — status updates, encrypted-creds
// resolve, etc.): ~2x concurrency, capped at 50 per worker process, since
// multiple worker machines × this formula could otherwise exhaust the shared
// Postgres `max_connections` budget. Operators can override with
// WORKER_DB_POOL_MAX after sizing their DB tier.
const defaultPoolMax = Math.min(50, Math.max(10, envPositiveInt("WORKER_TOTAL_CONCURRENCY") * 2));

const db = createDb(requireEnv("DATABASE_URL"), {
  max: envPositiveInt("WORKER_DB_POOL_MAX", defaultPoolMax),
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

/** Fails if Postgres is unreachable, so a bad DATABASE_URL stops a deploy at startup. */
export async function checkDatabase(): Promise<void> {
  await db.execute(sql`SELECT 1`);
}

export async function executeRun(job: RunJob, lockLost: AbortSignal): Promise<void> {
  // Per-run cancel signal. The poller below trips it when `vent-hq stop`
  // sets `vent:cancelled:<id>` in Redis (see apps/api/src/routes/runs.ts).
  // The runner checks `signal.aborted` at every turn boundary, throws,
  // preserves partial transcript, and hangs up the platform call.
  const cancelController = new AbortController();
  const signal = AbortSignal.any([cancelController.signal, lockLost]);
  // Declared outside the try so the finally always sees it; assigned inside
  // so a synchronous throw before scheduling doesn't leak a phantom interval.
  let cancelPoller: ReturnType<typeof setInterval> | null = null;

  try {
    // Claim the run. If it is no longer queued, another path (cancel, stuck-
    // run cleanup) already ended it, and placing the call would bill a run
    // the user was told is over.
    const [claimed] = await db
      .update(schema.runs)
      .set({ status: "running", started_at: new Date() })
      .where(and(eq(schema.runs.id, job.run_id), eq(schema.runs.status, "queued")))
      .returning({ id: schema.runs.id });
    if (!claimed) {
      console.log(`Run ${job.run_id} already ended before start — skipping call`);
      return;
    }

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

    await emitEvent(job.run_id, "run_started", "Run started");

    // Already-deployed agents: run calls directly in worker process
    const isRemote = isPlatformProvider(job.adapter) || !!job.agent_url;
    if (isRemote) {
      await emitEvent(job.run_id, "connecting", `Connecting to remote agent (${job.adapter})...`);
      await executeRemoteRun(db, job, signal);
      return;
    }

    // Local agent via agent session relay. Throw rather than return: BullMQ
    // tracks failure on thrown errors only — a silent return marks the job
    // "completed" even though the DB row says fail, hiding failures from
    // worker.on('failed') metrics. The outer catch handles cleanup.
    if (!job.agent_session_id) {
      throw new Error("Missing agent_session_id for local run");
    }

    await emitEvent(job.run_id, "connecting", "Connecting to local agent via session relay...");

    const machineId = await getSessionMachineId(job.agent_session_id);

    await executeSessionRun(job, machineId, signal);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    console.error(`Failed to run ${job.run_id}:`, errorMessage);
    // The API ends the run (status, run_complete). If this report
    // is lost too, the API's stuck-run cleanup ends it later.
    await postToApiWithRetry(
      "/internal/run-failed",
      { run_id: job.run_id, error_text: errorMessage.slice(0, 2000) },
      10_000,
      4,
    )
      .then((res) => {
        if (!res.ok) console.error(`run-failed report rejected for ${job.run_id}: HTTP ${res.status}`);
      })
      .catch((reportErr: Error) => {
        console.error(`run-failed report lost for ${job.run_id}: ${reportErr.message}`);
      });

    throw err;
  } finally {
    if (cancelPoller) clearInterval(cancelPoller);
  }
}
