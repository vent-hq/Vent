// IPC protocol between the worker (parent) and a call process (child).
// Each call runs in its own child process; see call-supervisor.ts.

import type { ConversationCallResult } from "@vent/shared";
import type { ExecuteCallOpts, ExecuteCallResult } from "@vent/runner/executor";

/** Everything the child needs to place one call. Must be JSON-serializable. */
export type CallInput = Pick<ExecuteCallOpts, "runId" | "userId" | "callSpec" | "channelConfig">;

export type ParentMessage =
  | { type: "start"; call: CallInput }
  /** reason "cancelled" = the user; anything else = why Vent stopped the call. */
  | { type: "cancel"; reason: string }
  | { type: "ping" };

export type ChildMessage =
  | { type: "call_complete"; result: ConversationCallResult }
  | { type: "result"; result: ExecuteCallResult }
  | { type: "error"; message: string }
  | { type: "pong" };
