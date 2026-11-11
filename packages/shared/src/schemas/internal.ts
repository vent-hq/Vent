/**
 * Messages between Vent's own programs; users never write these.
 *   - CLI ↔ API: login tokens, the agent-session response.
 *   - API → worker: the queue job for a run.
 *   - Worker → API: callbacks reporting progress, failure and the result.
 */

import { z } from "zod";
import { AdapterTypeSchema, ConversationCallSpecSchema } from "./suite.js";
import { ConversationCallResultSchema } from "./call-result.js";

/** CLI → API: exchange a refresh token for a new access token. */
export const RefreshTokenRequestSchema = z.object({
  refresh_token: z.string().regex(/^vent_[0-9a-f]{48}$/),
});

/** API → CLI: the tokens the CLI saves after login or refresh. */
export const AccessCredentialsSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: RefreshTokenRequestSchema.shape.refresh_token,
});

// A run's final status: the terminal subset of the DB runStatusEnum
// (`queued|running|pass|fail|cancelled`). The worker reports it in its result
// callback; the stop endpoint and stuck-run cleanup set it too. Keep it in
// step with the DB enum.
export const RUN_TERMINAL_STATUSES = ["pass", "fail", "cancelled"] as const;
export type RunTerminalStatus = (typeof RUN_TERMINAL_STATUSES)[number];

/** Worker → API: the call finished; its result ends the run. */
export const WorkerResultCallbackSchema = z.object({
  run_id: z.string().uuid(),
  status: z.enum(RUN_TERMINAL_STATUSES),
  conversation_result: ConversationCallResultSchema,
  error_text: z.string().optional(),
});

/** Worker → API: the run failed before a result could be reported. */
export const RunFailedCallbackSchema = z.object({
  run_id: z.string().uuid(),
  error_text: z.string().max(2000),
});

/** Worker → API: a progress line ("Connecting…") shown live to the CLI, not stored. */
export const RunEventCallbackSchema = z.object({
  run_id: z.string().uuid(),
  event_type: z.string().min(1).max(64),
  message: z.string().max(2000),
  metadata_json: z.record(z.unknown()).optional(),
});

/** Worker → API callback bodies as the worker sends them, keyed by route path. */
export interface WorkerCallbackBodies {
  "/internal/run-event": z.input<typeof RunEventCallbackSchema>;
  "/internal/run-failed": z.input<typeof RunFailedCallbackSchema>;
  "/internal/runner-callback": z.input<typeof WorkerResultCallbackSchema>;
}

/** API → worker: the queue job for one run, built from the saved run so a
 *  lost job can be queued again (apps/api/src/lib/enqueue-run.ts). */
export const RunJobSchema = z.object({
  run_id: z.string().uuid(),
  user_id: z.string().min(1),
  adapter: AdapterTypeSchema,
  call_spec: z.object({ call: ConversationCallSpecSchema }),
  agent_url: z.string().optional(),
  agent_session_id: z.string().uuid().optional(),
});

/** POST /agent-sessions response: what the CLI needs to open the relay and start the local agent. */
export const AgentSessionResponseSchema = z.object({
  session_id: z.string().uuid(),
  relay_token: z.string(),
  api_url: z.string(),
  agent_port: z.number().int().min(1).max(65535),
  start_command: z.string().nullable(),
  health_endpoint: z.string(),
});
