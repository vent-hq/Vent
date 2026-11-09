import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@vent/db";
import { WorkOS } from "@workos-inc/node";
import { createAccessJwt, type AccessIdentity } from "../lib/access-jwt.js";

declare module "fastify" {
  interface FastifyInstance {
    issueAccessToken: (identity: AccessIdentity) => Promise<string>;
    verifyCredentialIssuer: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    verifyAccessToken: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    accessTokenUserId: (request: FastifyRequest) => Promise<string | null>;
    verifyAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    verifyAuthAndCsrf: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    accessTokenId?: string;
    userId?: string;
    authMethod?: "access_token" | "session";
  }
}

export const authPlugin = fp(async (app) => {
  const accessJwt = await createAccessJwt();
  app.decorate("issueAccessToken", accessJwt.sign);
  const workosApiKey = process.env["WORKOS_API_KEY"];
  const workosClientId = process.env["WORKOS_CLIENT_ID"];
  const cookiePassword = process.env["WORKOS_COOKIE_PASSWORD"];
  const workosEnabled =
    !!workosApiKey && !!workosClientId && !!cookiePassword;

  if (!workosEnabled) {
    const anyWorkosConfigured =
      !!workosApiKey || !!workosClientId || !!cookiePassword;
    if (anyWorkosConfigured) {
      app.log.warn(
        "WorkOS auth is partially configured. Session auth is disabled until WORKOS_API_KEY, WORKOS_CLIENT_ID, and WORKOS_COOKIE_PASSWORD are all set.",
      );
    } else {
      app.log.info("WorkOS auth is not configured. Access-token auth remains enabled.");
    }
  }

  const workos = workosEnabled
    ? new WorkOS(workosApiKey, { clientId: workosClientId })
    : null;

  type AccessTokenRead = AccessIdentity | "none" | "not_bearer" | "empty" | "invalid";
  const tokenReads = new WeakMap<FastifyRequest, Promise<AccessTokenRead>>();

  // Reads and verifies the request's Bearer access token, once per request:
  // the rate-limit key (runs.ts) and authentication both need the answer.
  function readAccessToken(request: FastifyRequest): Promise<AccessTokenRead> {
    let read = tokenReads.get(request);
    if (!read) {
      read = (async () => {
        const authHeader = request.headers["authorization"];
        if (!authHeader) return "none";
        if (!authHeader.startsWith("Bearer ")) return "not_bearer";
        const rawAccessToken = authHeader.slice(7).trim();
        if (!rawAccessToken) return "empty";
        return accessJwt.verify(rawAccessToken).catch(() => "invalid" as const);
      })();
      tokenReads.set(request, read);
    }
    return read;
  }

  async function tryAuthenticateAccessToken(
    request: FastifyRequest,
    reply: FastifyReply,
    rejectNonBearer: boolean,
  ): Promise<"ok" | "none" | "invalid"> {
    const read = await readAccessToken(request);
    if (read === "none") return "none";
    if (read === "not_bearer") {
      if (!rejectNonBearer) return "none";
      await reply.status(401).send({
        error: "Invalid authorization header. Expected 'Bearer <access_token>'.",
      });
      return "invalid";
    }
    if (read === "empty") {
      await reply.status(401).send({ error: "Missing access token value." });
      return "invalid";
    }
    if (read === "invalid") {
      await reply.status(401).send({ error: "Invalid or expired access token" });
      return "invalid";
    }

    request.accessTokenId = read.accessTokenId;
    request.userId = read.userId;
    request.authMethod = "access_token";
    return "ok";
  }

  // The user a request's access token proves, or null. Never replies.
  async function accessTokenUserId(request: FastifyRequest): Promise<string | null> {
    const read = await readAccessToken(request);
    return typeof read === "object" ? read.userId : null;
  }

  async function verifyAccessToken(request: FastifyRequest, reply: FastifyReply) {
    const accessTokenAuth = await tryAuthenticateAccessToken(request, reply, true);
    if (accessTokenAuth === "ok" || accessTokenAuth === "invalid") return;
    await reply.status(401).send({
      error: "Missing authentication. Provide a Bearer access token.",
    });
  }

  async function verifyAuth(request: FastifyRequest, reply: FastifyReply) {
    // Path 1: Bearer access token (CLI)
    const accessTokenAuth = await tryAuthenticateAccessToken(request, reply, false);
    if (accessTokenAuth === "ok" || accessTokenAuth === "invalid") {
      return;
    }

    // Path 2: WorkOS sealed session cookie (dashboard)
    const sessionCookie = request.cookies?.["wos-session"];
    if (sessionCookie) {
      if (!workos || !cookiePassword) {
        await reply.status(401).send({
          error: "Session authentication is not configured on this API server. Provide a Bearer access token.",
        });
        return;
      }

      try {
        const session = workos.userManagement.loadSealedSession({
          sessionData: sessionCookie,
          cookiePassword,
        });

        const authResult = await session.authenticate();

        if (authResult.authenticated) {
          request.userId = authResult.user.id;
          request.authMethod = "session";
          return;
        }

        // Access token expired — try refreshing via WorkOS API
        const refreshResult = await session.refresh();
        if (refreshResult.authenticated && refreshResult.sealedSession) {
          // Send refreshed cookie back through the proxy
          reply.header(
            "Set-Cookie",
            `wos-session=${refreshResult.sealedSession}; Path=/; HttpOnly; Secure; SameSite=Strict`
          );

          // Re-authenticate with the fresh session
          const fresh = workos.userManagement.loadSealedSession({
            sessionData: refreshResult.sealedSession,
            cookiePassword,
          });
          const freshAuth = await fresh.authenticate();
          if (freshAuth.authenticated) {
            request.userId = freshAuth.user.id;
            request.authMethod = "session";
            return;
          }
        }
      } catch (err) {
        app.log.warn({ err }, "Session authentication failed");
        // Fall through to 401
      }
    }

    await reply.status(401).send({
      error: "Missing or invalid authentication. Provide a Bearer access token or a valid session cookie.",
    });
  }

  // Allowlist of origins that may make cross-site mutating cookie requests.
  // Re-derive lazily because DASHBOARD_URL is read at startup in index.ts.
  const csrfAllowedOrigins = new Set<string>(
    [process.env["DASHBOARD_URL"], ...(process.env["DASHBOARD_URLS"] ?? "").split(",")]
      .map((s) => (s ?? "").trim())
      .filter((s) => s.length > 0),
  );

  // Stricter than verifyAuth — additionally enforces that cookie-authed
  // mutating requests come from an allowed Origin. Stops cross-site form
  // POSTs in the user's browser from triggering state changes (CSRF).
  // Bearer-token requests skip the Origin check (CLI/server-to-server).
  async function verifyAuthAndCsrf(request: FastifyRequest, reply: FastifyReply) {
    await verifyAuth(request, reply);
    if (reply.sent) return;
    if (request.authMethod === "session") {
      const origin = request.headers["origin"];
      if (!origin || !csrfAllowedOrigins.has(origin)) {
        await reply.status(403).send({ error: "CSRF: Origin not allowed for cookie-authed mutation" });
        return;
      }
    }
  }

  async function verifyCredentialIssuer(request: FastifyRequest, reply: FastifyReply) {
    await verifyAuthAndCsrf(request, reply);
    if (reply.sent || request.authMethod !== "access_token") return;
    const [active] = await app.db.select({ id: schema.accessTokens.id }).from(schema.accessTokens).where(and(
      eq(schema.accessTokens.id, request.accessTokenId!),
      eq(schema.accessTokens.user_id, request.userId!),
      isNull(schema.accessTokens.revoked_at),
    )).limit(1);
    if (!active) await reply.status(401).send({ error: "Credential was revoked" });
  }

  app.decorate("verifyAccessToken", verifyAccessToken);
  app.decorate("accessTokenUserId", accessTokenUserId);
  app.decorate("verifyAuth", verifyAuth);
  app.decorate("verifyAuthAndCsrf", verifyAuthAndCsrf);
  app.decorate("verifyCredentialIssuer", verifyCredentialIssuer);
});
