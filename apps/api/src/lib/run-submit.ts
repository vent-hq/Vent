import { createHash } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { schema } from "@vent/db";
import { z } from "zod";
import {
  AdapterTypeSchema,
  ConversationCallSpecSchema,
  CallerAudioEffectsSchema,
  PlatformConfigSchema,
  FLEET_ACTIVE_RUNS_KEY,
} from "@vent/shared";
import { encryptPlatformConfig, validateResolvedPlatformConfig } from "@vent/platform-connections";
import type { FastifyInstance } from "fastify";

const PLATFORM_ADAPTERS = new Set(["livekit", "vapi", "retell", "elevenlabs", "bland"]);

export class FleetCapacityError extends Error {
  constructor() {
    super("All test slots are in use. Please retry in a few minutes.");
    this.name = "FleetCapacityError";
  }
}

export class SubmitRunConfigError extends Error {
  public statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "SubmitRunConfigError";
    this.statusCode = statusCode;
  }
}

// ---- Zod schema for run submission ----

export const RunSubmitConfigSchema = z.object({
  connection: z.object({
    adapter: AdapterTypeSchema.default("websocket"),
    agent_url: z.string().optional(),
    agent_port: z.number().int().min(1).max(65535).optional(),
    start_command: z.string().optional(),
    health_endpoint: z.string().optional(),
    caller_audio: CallerAudioEffectsSchema.optional(),
    platform: PlatformConfigSchema.optional(),
  }),
  call: ConversationCallSpecSchema,
}).superRefine((d, ctx) => {
  const adapter = d.connection.adapter;
  const platform = d.connection.platform;
  const requiresPlatform = PLATFORM_ADAPTERS.has(adapter);

  if (requiresPlatform && !platform) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["connection", "platform"],
      message: `${adapter} runs require platform configuration`,
    });
  }

  if (platform && (!requiresPlatform || platform.provider !== adapter)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["connection", "platform"],
      message: "Platform provider must match the connection adapter",
    });
  }
  if (platform) {
    try {
      validateResolvedPlatformConfig(platform);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["connection", "platform"],
        message: (error as Error).message,
      });
    }
  }
});

export const RunSubmitSchema = z.object({
  config: RunSubmitConfigSchema,
  idempotency_key: z.string().uuid().optional(),
  agent_session_id: z.string().uuid().optional(),
});

export type RunSubmitInput = z.infer<typeof RunSubmitSchema>;

// ---- Helpers ----

export function hashIdempotencyKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function buildCallSpec(cfg: Record<string, unknown>) {
  const adapter = (cfg.adapter as string) ?? "websocket";
  const agentUrl = cfg.agent_url as string | undefined;
  const voiceConfig = { adapter };

  // Merge root-level caller_audio as default onto the call spec
  const callerAudio = cfg.caller_audio as Record<string, unknown> | undefined;
  let call = cfg.call as Record<string, unknown> | null | undefined;
  if (callerAudio && call && call.caller_audio === undefined) {
    call = { ...call, caller_audio: callerAudio };
  }

  return {
    callSpecJson: {
      call: call ?? null,
      adapter,
      voice_config: voiceConfig,
      start_command: cfg.start_command ?? null,
      health_endpoint: cfg.health_endpoint ?? null,
      agent_url: agentUrl ?? null,
    },
    adapter,
    agentUrl,
    voiceConfig,

    call: call ?? null,
    isRemote: PLATFORM_ADAPTERS.has(adapter) || !!agentUrl,
  };
}

// ---- Core submit function ----

export interface SubmitRunParams {
  accessTokenId: string;
  userId: string;
  config: RunSubmitInput["config"];
  idempotencyKey?: string;
  agentSessionId?: string;
}

export interface SubmitRunResult {
  run_id: string;
  status: string;
  deduplicated?: boolean;
}

export async function submitRun(
  app: FastifyInstance,
  params: SubmitRunParams,
): Promise<SubmitRunResult> {
  const { accessTokenId, userId, config, idempotencyKey, agentSessionId } = params;

  const hashedIdempotencyKey = idempotencyKey
    ? hashIdempotencyKey(idempotencyKey)
    : null;

  // Idempotency check
  if (hashedIdempotencyKey) {
    const [existing] = await app.db
      .select({ id: schema.runs.id, status: schema.runs.status })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.user_id, userId),
          eq(schema.runs.idempotency_key, hashedIdempotencyKey),
        ),
      )
      .limit(1);

    if (existing) {
      return { run_id: existing.id, status: existing.status, deduplicated: true };
    }
  }

  const { platform, ...connection } = config.connection;
  const { call: submittedCall } = config;
  const cfg = { ...connection, call: submittedCall } as Record<string, unknown>;

  const {
    callSpecJson,
    adapter: resolvedAdapter,
    agentUrl,
    voiceConfig,

    call,
    isRemote,
  } = buildCallSpec(cfg);

  // Fleet-wide capacity gate — reject before enqueuing to avoid mid-call provider errors.
  // Uses a Redis SET of run IDs: SADD is idempotent (no drift), SCARD gives exact count.
  // A Lua script makes the check-and-add atomic so no race between SCARD and SADD.
  const fleetMax = parseInt(process.env["FLEET_MAX_ACTIVE_RUNS"] ?? "45", 10);

  // Insert DB row first so we have a run_id to track in the SET.
  // If the SET add fails (capacity full), we mark the row as rejected.
  const sourceType = isRemote ? "remote" : "session";

  if (!isRemote) {
    // Local agent via agent session — session must already be active
    if (!agentSessionId) {
      throw new SubmitRunConfigError(
        "Non-remote runs require an agent_session_id. Start an agent session first with `npx vent-hq agent start`.",
      );
    }

    // Verify the agent session exists, belongs to the user, and is active
    const [agentSession] = await app.db
      .select({ id: schema.agentSessions.id, status: schema.agentSessions.status })
      .from(schema.agentSessions)
      .where(
        and(
          eq(schema.agentSessions.id, agentSessionId),
          eq(schema.agentSessions.user_id, userId),
        ),
      )
      .limit(1);

    if (!agentSession) {
      throw new SubmitRunConfigError("Agent session not found", 404);
    }
    if (agentSession.status !== "active") {
      throw new SubmitRunConfigError(
        `Agent session is "${agentSession.status}" — it must be "active". Ensure the relay tunnel is connected.`,
      );
    }

    const relayReady = await app.redis.get(`vent:relay-session:${agentSessionId}`);
    if (!relayReady) {
      throw new SubmitRunConfigError(
        "Agent session relay is no longer connected. Start a new session with `npx vent-hq agent start`.",
      );
    }
  }

  const [run] = await app.db
    .insert(schema.runs)
    .values({
      access_token_id: accessTokenId,
      user_id: userId,
      source_type: sourceType,
      status: "queued",
      test_spec_json: callSpecJson,
      platform_config_encrypted: platform ? encryptPlatformConfig(platform) : null,
      idempotency_key: hashedIdempotencyKey,
      ...(agentSessionId ? { agent_session_id: agentSessionId } : {}),
    })
    .returning();

  const runId = run!.id;

  // Atomic check-and-add: if SET size < fleetMax, SADD run_id and return 1; else return 0.
  const FLEET_CAP_SCRIPT = `
    if redis.call('scard', KEYS[1]) < tonumber(ARGV[1]) then
      redis.call('sadd', KEYS[1], ARGV[2])
      return 1
    end
    return 0
  `;
  const admitted = await app.redis.eval(
    FLEET_CAP_SCRIPT, 1, FLEET_ACTIVE_RUNS_KEY, String(fleetMax), runId,
  ) as number;

  const activeAfter = await app.redis.scard(FLEET_ACTIVE_RUNS_KEY);
  if (!admitted) {
    console.log(`[fleet-cap] REJECTED run=${runId} active=${activeAfter} max=${fleetMax}`);
    await app.db
      .update(schema.runs)
      .set({ status: "fail", finished_at: new Date(), error_text: "Fleet at capacity" })
      .where(eq(schema.runs.id, runId));
    throw new FleetCapacityError();
  }
  console.log(`[fleet-cap] ADMITTED run=${runId} active=${activeAfter} max=${fleetMax}`);

  // Enqueue the job
  const jobData = {
    run_id: runId,
    user_id: userId,
    adapter: resolvedAdapter,
    call_spec: { call: call ?? null },
    voice_config: voiceConfig,
    start_command: cfg.start_command as string | undefined,
    health_endpoint: cfg.health_endpoint as string | undefined,
    agent_url: agentUrl,
    ...(agentSessionId ? { agent_session_id: agentSessionId } : {}),
  };

  await app.getRunQueue(userId).add("execute-run", jobData, { jobId: runId });
  await app.markRunQueueActive(userId);

  return { run_id: runId, status: "queued" };
}
