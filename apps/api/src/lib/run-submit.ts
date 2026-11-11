import { createHash } from "node:crypto";
import { eq, and, count, sql } from "drizzle-orm";
import { schema, type RunTestSpec } from "@vent/db";
import { z } from "zod";
import {
  AdapterTypeSchema,
  ConversationCallSpecSchema,
  CallerAudioEffectsSchema,
  PlatformConfigSchema,
  envPositiveInt,
  missingPlatformFields,
  isPlatformProvider,
} from "@vent/shared";
import { encryptPlatformConfig } from "@vent/platform-connections";
import type { FastifyInstance } from "fastify";
import { finalizeRun } from "./finalize-run.js";
import { enqueueRun, type EnqueueableRun } from "./enqueue-run.js";


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
    caller_audio: CallerAudioEffectsSchema.optional(),
    platform: PlatformConfigSchema.optional(),
  }),
  call: ConversationCallSpecSchema,
}).superRefine((d, ctx) => {
  const adapter = d.connection.adapter;
  const platform = d.connection.platform;
  const requiresPlatform = isPlatformProvider(adapter);

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
    for (const anyOf of missingPlatformFields(platform)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["connection", "platform"],
        message: `${platform.provider} configuration requires ${anyOf.join(" or ")}`,
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

export function buildCallSpec(cfg: Record<string, unknown>): { callSpecJson: RunTestSpec; isRemote: boolean } {
  const adapter = (cfg.adapter as string) ?? "websocket";
  const agentUrl = cfg.agent_url as string | undefined;

  // Merge root-level caller_audio as default onto the call spec
  const callerAudio = cfg.caller_audio as Record<string, unknown> | undefined;
  let call = cfg.call as Record<string, unknown>;
  if (callerAudio && call.caller_audio === undefined) {
    call = { ...call, caller_audio: callerAudio };
  }

  return {
    callSpecJson: {
      call,
      adapter,
      agent_url: agentUrl ?? null,
    },
    isRemote: isPlatformProvider(adapter) || !!agentUrl,
  };
}

// ---- Core submit function ----

export interface SubmitRunParams {
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
  const { userId, config, idempotencyKey, agentSessionId } = params;

  const hashedIdempotencyKey = idempotencyKey
    ? hashIdempotencyKey(idempotencyKey)
    : null;

  const { platform, ...connection } = config.connection;
  const { call: submittedCall } = config;
  const cfg = { ...connection, call: submittedCall } as Record<string, unknown>;

  const { callSpecJson, isRemote } = buildCallSpec(cfg);

  const fleetMax = envPositiveInt("FLEET_MAX_ACTIVE_RUNS");

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

  const platformConfig = platform ? encryptPlatformConfig(platform) : null;
  const admission = await app.db.transaction(async (tx): Promise<SubmitRunResult | EnqueueableRun> => {
    // Serialize fleet admissions across API instances until this transaction ends.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(173827, 2)`);

    if (hashedIdempotencyKey) {
      const [existing] = await tx
        .select({ id: schema.runs.id, status: schema.runs.status })
        .from(schema.runs)
        .where(and(
          eq(schema.runs.user_id, userId),
          eq(schema.runs.idempotency_key, hashedIdempotencyKey),
        ))
        .limit(1);
      if (existing) return { run_id: existing.id, status: existing.status, deduplicated: true };
    }

    const [active] = await tx
      .select({ total: count() })
      .from(schema.runs)
      // Statuses written into the SQL text (not bound parameters) so Postgres can
      // always match this to runs_open_idx, even with a reused plan.
      .where(sql`${schema.runs.status} IN ('queued', 'running')`);
    if (active!.total >= fleetMax) throw new FleetCapacityError();

    const [run] = await tx
      .insert(schema.runs)
      .values({
        user_id: userId,
        status: "queued",
        test_spec_json: callSpecJson,
        platform_config_encrypted: platformConfig,
        idempotency_key: hashedIdempotencyKey,
        ...(agentSessionId ? { agent_session_id: agentSessionId } : {}),
      })
      .returning();
    return run!;
  });
  if ("run_id" in admission) return admission;

  const runId = admission.id;
  try {
    await enqueueRun(app, admission);
  } catch (error) {
    await finalizeRun(app, {
      runId,
      status: "fail",
      from: ["queued"],
      errorText: "Could not add the run to the worker queue",
    });
    throw error;
  }

  return { run_id: runId, status: "queued" };
}
