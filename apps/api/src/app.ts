import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { healthRoutes } from "./routes/health.js";
import { runRoutes } from "./routes/runs.js";
import { callbackRoutes } from "./routes/callback.js";
import { keyRoutes } from "./routes/keys.js";
import { relayRoutes } from "./routes/local-relay/transport.js";
import { deviceRoutes } from "./routes/device.js";
import { agentAuthRoutes } from "./routes/agent-auth.js";
import { agentSessionRoutes } from "./routes/local-relay/sessions.js";
import { recordingRoutes } from "./routes/recordings.js";
import { dbPlugin } from "./plugins/db.js";
import { queuePlugin } from "./plugins/queue.js";
import { authPlugin } from "./plugins/auth.js";
import { rateLimitPlugin } from "./plugins/rate-limit.js";
import { shutdownSubscribers } from "./lib/run-subscribers.js";

import { registerRunCleanup } from "./lib/run-cleanup.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: "info",
    },
    // Default 1MB. Internal callback routes that carry full transcripts opt
    // into a higher per-route limit via { bodyLimit } in their route options.
    bodyLimit: 1 * 1024 * 1024,
    // Signed recording tokens are longer than the router's default param limit.
    routerOptions: {
      maxParamLength: 512,
    },
    trustProxy: false,
  });

  const dashboardUrl = process.env["DASHBOARD_URL"];
  const additionalDashboardUrls = (process.env["DASHBOARD_URLS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const devLocalOrigins =
    process.env["NODE_ENV"] === "production"
      ? []
      : ["http://localhost:3000", "http://127.0.0.1:3000"];
  const allowedOrigins = new Set<string>([
    ...(dashboardUrl ? [dashboardUrl] : []),
    ...additionalDashboardUrls,
    ...devLocalOrigins,
  ]);

  // Capture the raw JSON body alongside parsing so internal-callback routes
  // can HMAC-verify the bytes before trusting the parsed object. Replaces
  // Fastify's default JSON parser (same behavior, plus rawBody capture).
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body, done) => {
      const text = typeof body === "string" ? body : body.toString("utf8");
      (req as unknown as { rawBody?: string }).rawBody = text;
      if (text.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Global error handler — without this, Fastify's default sends `error.message`
  // (and stack in dev) back to the client, which can leak DB query text, env
  // var contents, internal paths, etc. Log full error server-side, return
  // a generic message to the client. 4xx errors with explicit messages
  // (e.g. validation, auth) are still passed through verbatim.
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, request, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err, path: request.url }, "request error");
      return reply.status(status).send({ error: "Internal server error" });
    }
    return reply.status(status).send({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
    });
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      // Non-browser/system callers (CLI, worker, server-to-server) omit Origin.
      // Letting them through is fine for cookie-less Bearer-auth requests, but
      // we never accept cookies cross-origin so credentials:true is paired
      // with strict allowlist checking when an Origin is present.
      if (!origin) {
        cb(null, true);
        return;
      }
      cb(null, allowedOrigins.has(origin));
    },
    credentials: true,
  });
  await app.register(cookie);
  await app.register(websocket);
  await app.register(dbPlugin);
  await app.register(queuePlugin);
  await app.register(authPlugin);

  await app.register(rateLimitPlugin);
  await app.register(healthRoutes);
  await app.register(runRoutes);
  await app.register(callbackRoutes);
  await app.register(keyRoutes);
  await app.register(relayRoutes);
  await app.register(deviceRoutes);
  await app.register(agentAuthRoutes);
  await app.register(agentSessionRoutes);
  await app.register(recordingRoutes);

  app.addHook("onClose", shutdownSubscribers);
  registerRunCleanup(app);
  return app;
}
