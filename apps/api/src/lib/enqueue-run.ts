import type { FastifyInstance } from "fastify";
import type { RunTestSpec } from "@vent/db";

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
  await app.runQueue.add(
    "execute-run",
    {
      run_id: run.id,
      user_id: run.user_id,
      adapter: spec.adapter,
      call_spec: { call: spec.call },
      voice_config: spec.voice_config,
      start_command: spec.start_command ?? undefined,
      health_endpoint: spec.health_endpoint ?? undefined,
      agent_url: spec.agent_url ?? undefined,
      ...(run.agent_session_id ? { agent_session_id: run.agent_session_id } : {}),
    },
    { jobId: run.id },
  );
}
