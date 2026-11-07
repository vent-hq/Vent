import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import IORedis from "ioredis";
import { schema } from "@vent/db";
import { timingSafeEqual } from "node:crypto";
import { RUNNER_CALLBACK_HEADER, requireEnv } from "@vent/shared";

function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
import { broadcast } from "../lib/run-subscribers.js";
import type WebSocket from "ws";

// ---------------------------------------------------------------------------
// Load bundled relay client at startup (served at GET /relay/client.mjs)
// ---------------------------------------------------------------------------

let relayClientBundle: string;
try {
  relayClientBundle = readFileSync(join(__dirname, "..", "relay-client.mjs"), "utf-8");
} catch {
  relayClientBundle = "// relay-client bundle not found — build packages/relay-client first";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunnerConnection {
  runner: WebSocket;
  connId: string;
  buffered: Array<{ payload: Buffer; frameType: number }>;
  ready: boolean;
}

interface RelaySession {
  /** The key this session is stored under — either a session_id or run_id */
  sessionKey: string;
  machineId: string;
  userId: string;
  controlWs: WebSocket;
  connections: Map<string, RunnerConnection>;
  createdAt: number;
  pingInterval: ReturnType<typeof setInterval>;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Relay sessions keyed by session_id (agent sessions) or run_id (legacy) */
const relaySessions = new Map<string, RelaySession>();

const PING_INTERVAL_MS = 30_000;
const MAX_BUFFER_BYTES = 1_048_576; // 1 MB safety limit per connection

// Redis — pub/sub for instant notification + key for cross-instance relay-ready checks
const redisUrl = requireEnv("REDIS_URL");
const redisPub = new IORedis(redisUrl, { maxRetriesPerRequest: null });

// ---------------------------------------------------------------------------
// Binary framing helpers
// ---------------------------------------------------------------------------

const FRAME_BINARY = 0x01;
const FRAME_TEXT = 0x02;

function sendDataFrame(session: RelaySession, connId: string, payload: Buffer, frameType = FRAME_BINARY): void {
  if (session.controlWs.readyState !== session.controlWs.OPEN) return;
  const header = Buffer.alloc(37);
  header[0] = frameType;
  header.write(connId, 1, 36, "ascii");
  const frame = Buffer.concat([header, payload]);
  session.controlWs.send(frame, { binary: true });
}

function parseDataFrame(data: Buffer): { connId: string; payload: Buffer; isText: boolean } | null {
  if (data.length < 37) return null;
  const type = data[0];
  if (type !== FRAME_BINARY && type !== FRAME_TEXT) return null;
  const connId = data.toString("ascii", 1, 37);
  const payload = data.subarray(37);
  return { connId, payload, isText: type === FRAME_TEXT };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRelaySession(key: string): RelaySession | null {
  return relaySessions.get(key) ?? null;
}

function sendControl(session: RelaySession, payload: Record<string, unknown>): void {
  try {
    if (session.controlWs.readyState === session.controlWs.OPEN) {
      session.controlWs.send(JSON.stringify(payload));
    }
  } catch {
    // Best-effort delivery
  }
}

async function refreshRelayPresence(session: RelaySession): Promise<void> {
  await redisPub.set(`vent:relay-session:${session.sessionKey}`, session.machineId, "EX", 600);
}

function cleanupSession(
  key: string,
  opts?: { closeControl?: boolean; code?: number; reason?: string },
): void {
  const session = relaySessions.get(key);
  if (!session) return;

  clearInterval(session.pingInterval);

  for (const [, conn] of session.connections) {
    if (conn.runner.readyState === conn.runner.OPEN) conn.runner.close();
  }

  session.connections.clear();
  relaySessions.delete(key);

  if (opts?.closeControl && session.controlWs.readyState === session.controlWs.OPEN) {
    session.controlWs.close(opts.code ?? 1000, opts.reason ?? "session_closed");
  }

  // Clean up Redis key
  void redisPub.del(`vent:relay-session:${key}`);
}


function isValidUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

async function relayRoutes(app: FastifyInstance) {
  // GET /relay/control — Control + data channel from the relay client (multiplexed)
  // Supports two modes:
  //   1. session_id + token → agent session (new: multiple runs share one tunnel)
  //   2. run_id + token → single-run relay (legacy)
  app.get("/relay/control", { websocket: true }, async (socket, req) => {
    const query = req.query as { session_id?: string; run_id?: string; token?: string };
    const token = query.token;
    const sessionId = query.session_id;
    const runId = query.run_id;

    // Determine which mode we're in
    const sessionKey = sessionId ?? runId;
    const isAgentSession = !!sessionId;

    if (!sessionKey || !token || !isValidUUID(sessionKey)) {
      socket.close(4400, "Missing or invalid session_id/run_id/token");
      return;
    }

    if (relaySessions.has(sessionKey)) {
      socket.close(4409, "Relay already connected for this session");
      return;
    }

    // Authenticate
    let userId: string;
    if (isAgentSession) {
      // Agent session mode — look up agent_sessions table
      let agentSession: { id: string; user_id: string; relay_token: string } | undefined;
      try {
        const [row] = await app.db
          .select({
            id: schema.agentSessions.id,
            user_id: schema.agentSessions.user_id,
            relay_token: schema.agentSessions.relay_token,
          })
          .from(schema.agentSessions)
          .where(
            and(
              eq(schema.agentSessions.id, sessionId!),
              eq(schema.agentSessions.status, "connecting"),
            ),
          )
          .limit(1);
        agentSession = row;
      } catch (err) {
        app.log.error({ sessionId, err }, "relay/control: agent session DB lookup failed");
        socket.close(4500, "Internal error");
        return;
      }

      if (!agentSession) {
        socket.close(4404, "Agent session not found or already active");
        return;
      }

      if (agentSession.relay_token !== token) {
        socket.close(4401, "Invalid relay token");
        return;
      }

      userId = agentSession.user_id;

      // Mark session as active
      await app.db
        .update(schema.agentSessions)
        .set({ status: "active" })
        .where(eq(schema.agentSessions.id, sessionId!));
    } else {
      // Legacy run-based mode
      let run: { id: string; user_id: string; relay_token: string | null } | undefined;
      try {
        const [row] = await app.db
          .select({
            id: schema.runs.id,
            user_id: schema.runs.user_id,
            relay_token: schema.runs.relay_token,
          })
          .from(schema.runs)
          .where(eq(schema.runs.id, runId!))
          .limit(1);
        run = row;
      } catch (err) {
        app.log.error({ runId, err }, "relay/control: DB lookup failed");
        socket.close(4500, "Internal error");
        return;
      }

      if (!run) {
        socket.close(4404, "Run not found");
        return;
      }

      if (!run.relay_token || run.relay_token !== token) {
        socket.close(4401, "Invalid relay token");
        return;
      }

      userId = run.user_id;
    }

    const machineId = process.env["FLY_MACHINE_ID"] ?? "local";
    const session: RelaySession = {
      sessionKey,
      machineId,
      userId,
      controlWs: socket,
      connections: new Map(),
      createdAt: Date.now(),
      pingInterval: setInterval(() => {
        void refreshRelayPresence(session).catch((err) => {
          app.log.error({ sessionKey, err }, "relay/control: FAILED to refresh Redis key");
        });

        try {
          if (socket.readyState === socket.OPEN) {
            socket.ping();
          }
        } catch {
          // Socket went away
        }
      }, PING_INTERVAL_MS),
    };

    relaySessions.set(sessionKey, session);
    app.log.info({ sessionKey, isAgentSession }, "relay/control: connected");

    // Set a persistent Redis key so the worker can confirm relay is ready.
    try {
      await refreshRelayPresence(session);
      app.log.info({ sessionKey }, "relay/control: Redis key SET confirmed");
    } catch (err) {
      app.log.error({ sessionKey, err }, "relay/control: FAILED to set Redis key");
    }

    // Notify worker via Redis pub/sub — instant notification
    try {
      await redisPub.publish(`vent:relay-ready:${sessionKey}`, "1");
      app.log.info({ sessionKey }, "relay/control: Redis PUBLISH confirmed");
    } catch (err) {
      app.log.error({ sessionKey, err }, "relay/control: FAILED to publish relay-ready");
    }

    // Empty env handshake — preserves the relay-client connect ack ("config_received"
    // event resolves the connect Promise). We deliberately do NOT forward provider
    // API keys: any caller with a bootstrap access token could harvest server-side
    // Deepgram/Anthropic keys. The local agent must bring its own credentials via
    // its own process env / dotenv.
    sendControl(session, { type: "config", env: {} });

    if (!isAgentSession && runId) {
      broadcast(runId, {
        run_id: runId,
        event_type: "relay_connected",
        message: "Local dev tunnel connected",
        created_at: new Date().toISOString(),
      });
    }

    // Handle multiplexed data + control messages from CLI
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        // Binary frame: data from local agent → forward to runner
        const frame = parseDataFrame(data);
        if (!frame) return;
        const conn = session.connections.get(frame.connId);
        if (conn && conn.runner.readyState === conn.runner.OPEN) {
          conn.runner.send(frame.payload, { binary: !frame.isText });
        }
      } else {
        // Text frame: control message from CLI
        try {
          const msg = JSON.parse(data.toString()) as { type: string; conn_id?: string };
          if (msg.type === "open_ack" && msg.conn_id) {
            const conn = session.connections.get(msg.conn_id);
            if (conn) {
              conn.ready = true;
              // Flush buffered runner data
              for (const { payload, frameType } of conn.buffered) {
                sendDataFrame(session, msg.conn_id, payload, frameType);
              }
              conn.buffered = [];
              app.log.info({ sessionKey, connId: msg.conn_id }, "relay/control: open_ack received, flushed buffer");
            }
          } else if (msg.type === "close" && msg.conn_id) {
            const conn = session.connections.get(msg.conn_id);
            if (conn && conn.runner.readyState === conn.runner.OPEN) {
              conn.runner.close();
            }
            session.connections.delete(msg.conn_id);
          }
        } catch {
          // Ignore malformed
        }
      }
    });

    let finalized = false;
    const finalizeAgentSession = () => {
      if (finalized) return;
      finalized = true;
      cleanupSession(sessionKey);
      if (isAgentSession && sessionId) {
        void app.db
          .update(schema.agentSessions)
          .set({ status: "closed", closed_at: new Date() })
          .where(eq(schema.agentSessions.id, sessionId))
          .catch((err) => {
            app.log.error({ sessionId, err }, "relay/control: failed to mark agent session closed");
          });
      }
    };

    socket.on("close", () => {
      app.log.info({ sessionKey }, "relay/control: disconnected");
      finalizeAgentSession();
    });

    socket.on("error", (err) => {
      app.log.error({ sessionKey, err: err.message }, "relay/control: socket error");
      finalizeAgentSession();
    });
  });

  // GET /relay/connect — Runner (worker) data channel, one per call
  // Supports: session_id (agent sessions) or run_id (legacy) for session lookup
  app.get("/relay/connect", { websocket: true }, async (socket, req) => {
    const query = req.query as { session_id?: string; run_id?: string; conn_id?: string };
    const sessionId = query.session_id;
    const runId = query.run_id;
    const connId = query.conn_id;
    const sessionKey = sessionId ?? runId;

    const secret = (req.headers as Record<string, string>)[RUNNER_CALLBACK_HEADER];
    const expectedSecret = process.env["RUNNER_CALLBACK_SECRET"];

    if (!expectedSecret || !secret || !timingSafeCompare(secret, expectedSecret)) {
      socket.close(4401, "Unauthorized");
      return;
    }

    if (!sessionKey || !connId || !isValidUUID(sessionKey) || !isValidUUID(connId)) {
      socket.close(4400, "Missing or invalid session_id/run_id/conn_id");
      return;
    }

    const session = relaySessions.get(sessionKey);
    if (!session) {
      socket.close(4404, "No relay session for this key");
      return;
    }

    if (session.connections.has(connId)) {
      socket.close(4409, "Connection already exists for this conn_id");
      return;
    }

    const conn: RunnerConnection = {
      runner: socket,
      connId,
      buffered: [],
      ready: false,
    };
    session.connections.set(connId, conn);
    app.log.info({ sessionKey, connId }, "relay/connect: runner connected");

    // Notify CLI of new connection
    sendControl(session, { type: "new_connection", conn_id: connId });

    // Forward runner data to CLI over control WS (multiplexed)
    let bufferedBytes = 0;
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      const payload = Buffer.from(data);
      const frameType = isBinary ? FRAME_BINARY : FRAME_TEXT;
      if (conn.ready) {
        sendDataFrame(session, connId, payload, frameType);
      } else {
        bufferedBytes += payload.length;
        if (bufferedBytes > MAX_BUFFER_BYTES) {
          app.log.warn({ sessionKey, connId, bufferedBytes }, "relay/connect: buffer limit exceeded, closing");
          socket.close(4413, "Buffer limit exceeded");
          return;
        }
        conn.buffered.push({ payload, frameType });
      }
    });

    socket.on("close", () => {
      // Notify CLI that this connection closed
      sendControl(session, { type: "close", conn_id: connId });
      session.connections.delete(connId);
    });

    socket.on("error", (err) => {
      app.log.error({ sessionKey, connId, err: err.message }, "relay/connect: socket error");
    });
  });

  // GET /internal/relay-ready/:id — Worker polls this to know when relay tunnel is connected
  // :id can be either a session_id or run_id
  app.get<{ Params: { id: string } }>("/internal/relay-ready/:id", async (request, reply) => {
    const secret = (request.headers as Record<string, string>)[RUNNER_CALLBACK_HEADER];
    const expectedSecret = process.env["RUNNER_CALLBACK_SECRET"];
    if (!expectedSecret || !secret || !timingSafeCompare(secret, expectedSecret)) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    // Check local in-memory first (fast path), then Redis (cross-instance)
    if (relaySessions.has(request.params.id)) {
      return reply.send({ ready: true });
    }

    const redisReady = await redisPub.get(`vent:relay-session:${request.params.id}`);
    if (redisReady) {
      return reply.send({ ready: true });
    }

    return reply.status(404).send({ ready: false });
  });

  // GET /relay/client.mjs — Serve the bundled relay client script
  app.get("/relay/client.mjs", async (_request, reply) => {
    return reply
      .header("Content-Type", "application/javascript; charset=utf-8")
      .header("Cache-Control", "no-cache")
      .send(relayClientBundle);
  });

  // Cleanup on server shutdown
  app.addHook("onClose", async () => {
    for (const [key] of relaySessions) {
      cleanupSession(key);
    }
    redisPub.disconnect();
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  relayRoutes,
  relaySessions,
  getRelaySession,
  cleanupSession,
};
export type { RelaySession, RunnerConnection };
