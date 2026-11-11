import type { FastifyInstance } from "fastify";
import type { RunTestSpec } from "@vent/db";
import { RunJobSchema, type RunJob } from "@vent/shared";

/** The run columns a worker job is built from. */
export interface EnqueueableRun {
  id: string;
  user_id: string;
  test_spec_json: RunTestSpec;
  agent_session_id: string | null;
}

// Adds the run's job to the run queue, built only from the saved run, so the
// stuck-run cleanup can re-queue a run whose submit died after saving it. The
// job ID is the run ID: BullMQ ignores an add whose job ID already exists, so
// queueing the same run twice is harmless.
export async function enqueueRun(app: FastifyInstance, run: EnqueueableRun): Promise<void> {
  const spec = run.test_spec_json;
  const job: RunJob = RunJobSchema.parse({
    run_id: run.id,
    user_id: run.user_id,
    adapter: spec.adapter,
    call_spec: { call: spec.call },
    agent_url: spec.agent_url ?? undefined,
    agent_session_id: run.agent_session_id ?? undefined,
  });
  await app.runQueue.add("execute-run", job, { jobId: run.id });
}
