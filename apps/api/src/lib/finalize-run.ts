import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@vent/db";
import type { ConversationCallResult, RunTerminalStatus } from "@vent/shared";
import { broadcast } from "./run-subscribers.js";

export type OpenRunStatus = "queued" | "running";

export interface FinalizeRunInput {
  runId: string;
  status: RunTerminalStatus;
  /** Statuses this caller may end the run from. If the run has already left
   *  them, another path ended it first and this call does nothing. */
  from: OpenRunStatus[];
  errorText?: string | null;
  /** The raw call result, stored as is; buildRunOutput formats it when served. */
  result?: ConversationCallResult;
}

// Save the final status and result on the run; the first caller wins. Streams
// then read the result from the run row (apps/api/src/routes/runs.ts).
export async function finalizeRun(app: FastifyInstance, input: FinalizeRunInput): Promise<boolean> {
  const { runId, status, from, result } = input;
  const errorText = input.errorText ?? null;

  const [ended] = await app.db
    .update(schema.runs)
    .set({
      status,
      finished_at: new Date(),
      error_text: errorText,
      ...(result ? { duration_ms: result.duration_ms, result_json: result } : {}),
    })
    .where(and(eq(schema.runs.id, runId), inArray(schema.runs.status, from)))
    .returning({ id: schema.runs.id });

  if (!ended) {
    app.log.info({ run_id: runId, status, from }, "finalizeRun: run already ended");
    return false;
  }

  broadcast(runId, {
    run_id: runId,
    event_type: "run_complete",
    message: `${status}${errorText ? `: ${errorText}` : ""}`,
    created_at: new Date().toISOString(),
  });
  app.log.info({ run_id: runId, status }, "finalizeRun: run ended");
  return true;
}
