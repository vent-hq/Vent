import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@vent/db";
import type { RunnerCallbackV2Schema } from "@vent/shared";
import { broadcast } from "./run-subscribers.js";

type RunnerCallback = z.infer<typeof RunnerCallbackV2Schema>;

export type FinalRunStatus = "pass" | "fail" | "cancelled";
export type OpenRunStatus = "queued" | "running";

export interface FinalizeRunInput {
  runId: string;
  status: FinalRunStatus;
  /** Statuses this caller may end the run from. If the run has already left
   *  them, another path ended it first and this call does nothing. */
  from: OpenRunStatus[];
  errorText?: string | null;
  result?: Pick<RunnerCallback, "conversation_result" | "aggregate">;
}

// Save the final status, results and completion event together; the first caller wins.
export async function finalizeRun(app: FastifyInstance, input: FinalizeRunInput): Promise<boolean> {
  const { runId, status, from, result } = input;
  const errorText = input.errorText ?? null;
  const counts = result?.aggregate.conversation_calls;
  const message = counts
    ? `${status}: ${counts.passed}/${counts.total} conversation`
    : `${status}${errorText ? `: ${errorText}` : ""}`;
  const metadata: Record<string, unknown> = {
    status,
    error_text: errorText,
    ...(result && counts
      ? {
          total_calls: 1,
          passed_calls: counts.passed,
          failed_calls: counts.failed,
          aggregate: result.aggregate,
        }
      : {}),
  };

  const event = await app.db.transaction(async (tx) => {
    const [ended] = await tx
      .update(schema.runs)
      .set({
        status,
        finished_at: new Date(),
        error_text: errorText,
        ...(result
          ? { duration_ms: result.aggregate.total_duration_ms, aggregate_json: result.aggregate }
          : {}),
      })
      .where(and(eq(schema.runs.id, runId), inArray(schema.runs.status, from)))
      .returning({ id: schema.runs.id });
    if (!ended) return null;

    if (result) {
      const call = result.conversation_result;
      await tx.delete(schema.scenarioResults).where(eq(schema.scenarioResults.run_id, runId));
      await tx.insert(schema.scenarioResults).values({
        run_id: runId,
        name: call.name ?? `conversation:${call.caller_prompt.slice(0, 50)}`,
        status: call.status,
        metrics_json: call,
      });
    }

    const [inserted] = await tx
      .insert(schema.runEvents)
      .values({ run_id: runId, event_type: "run_complete", message, metadata_json: metadata })
      .returning();
    return inserted!;
  });

  if (!event) {
    app.log.info({ run_id: runId, status, from }, "finalizeRun: run already ended");
    return false;
  }

  broadcast(runId, {
    id: event.id,
    run_id: runId,
    event_type: "run_complete",
    message,
    metadata_json: metadata,
    created_at: event.created_at.toISOString(),
  });
  app.log.info({ run_id: runId, status }, "finalizeRun: run ended");
  return true;
}
