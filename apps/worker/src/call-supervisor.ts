// Runs each call in its own child process (call-process.ts).
//
// Why: calls are real-time audio. Sharing one event loop lets one call's CPU
// spike stutter another call's audio, and one native crash (LiveKit FFI) or
// OOM kills every call on the worker. A child per call isolates both, and a
// stuck call can be killed on its own. Same model as LiveKit Agents.
//
// The parent keeps all state (queue, DB, Redis, callbacks); the child only
// places the call. Every way a call can end — result, error, crash, kill —
// settles the returned promise exactly once, from the child's `close` event.

import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { ExecuteCallResult } from "@vent/runner/executor";
import type { CallInput, ChildMessage, ParentMessage } from "./call-messages.js";

export const CALL_PROCESS_ENTRY = path.join(__dirname, "call-process.js");

export interface CallProcessLimits {
  /** Hard ceiling on one call, so a stuck call can't hold its slot forever.
   *  Well above the longest legitimate call (50 turns). */
  timeoutMs: number;
  /** How long a call may take to hang up after `cancel` before it is killed.
   *  The runner honors cancel at turn boundaries, which can take ~30s. */
  cancelGraceMs: number;
  /** No pong for this long means the child's event loop is blocked. Pings go
   *  out every pingTimeoutMs / 6 (5s by default). */
  pingTimeoutMs: number;
}

export const DEFAULT_CALL_PROCESS_LIMITS: CallProcessLimits = {
  timeoutMs: 30 * 60_000,
  cancelGraceMs: 45_000,
  pingTimeoutMs: 30_000,
};

const liveCalls = new Set<ChildProcess>();

function send(child: ChildProcess, message: ParentMessage): void {
  if (child.connected) child.send(message);
}

/** Ask every running call to hang up (worker shutdown). */
export function cancelAllCalls(): void {
  for (const child of liveCalls) send(child, { type: "cancel", reason: "the worker shut down for a deploy" });
}

export function runCallInProcess(
  entry: string,
  call: CallInput,
  opts: {
    signal: AbortSignal;
    limits?: Partial<CallProcessLimits>;
  },
): Promise<ExecuteCallResult> {
  const limits = { ...DEFAULT_CALL_PROCESS_LIMITS, ...opts.limits };
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  liveCalls.add(child);

  // Child output goes through console so it lands in this run's log file.
  child.stdout!.on("data", (chunk: Buffer) => console.log(chunk.toString().trimEnd()));
  child.stderr!.on("data", (chunk: Buffer) => console.error(chunk.toString().trimEnd()));

  let result: ExecuteCallResult | null = null;
  let error: string | null = null;
  let killReason: string | null = null;
  let lastPong = Date.now();

  const kill = (reason: string) => {
    if (killReason) return;
    killReason = reason;
    child.kill("SIGKILL");
  };

  // Ask the call to hang up; kill it if it hasn't exited within the grace period.
  let cancelTimer: NodeJS.Timeout | null = null;
  const cancel = (reason: string) => {
    if (cancelTimer) return;
    send(child, { type: "cancel", reason });
    cancelTimer = setTimeout(() => kill(`the call did not stop within ${limits.cancelGraceMs / 1000}s of being stopped (${reason})`), limits.cancelGraceMs);
  };

  const onAbort = () => cancel("cancelled");
  opts.signal.addEventListener("abort", onAbort, { once: true });
  if (opts.signal.aborted) onAbort();

  const timeoutTimer = setTimeout(() => cancel(`it hit the ${limits.timeoutMs / 60_000}-minute call limit`), limits.timeoutMs);
  const pingTimer = setInterval(() => {
    if (Date.now() - lastPong > limits.pingTimeoutMs) {
      kill(`call process unresponsive for ${limits.pingTimeoutMs / 1000}s`);
      return;
    }
    send(child, { type: "ping" });
  }, limits.pingTimeoutMs / 6);

  // e.g. an IPC send racing the child's exit. Unhandled, it would crash the worker.
  child.on("error", (err) => console.error(`[call-process] ${err.message}`));

  child.on("message", (message: ChildMessage) => {
    switch (message.type) {
      case "pong":
        lastPong = Date.now();
        break;
      case "result":
        result = message.result;
        break;
      case "error":
        error = message.message;
        break;
    }
  });

  send(child, { type: "start", call });

  return new Promise((resolve, reject) => {
    // `close` fires once, after the process exited and its output was flushed.
    child.on("close", (code, signal) => {
      liveCalls.delete(child);
      clearTimeout(timeoutTimer);
      clearInterval(pingTimer);
      if (cancelTimer) clearTimeout(cancelTimer);
      opts.signal.removeEventListener("abort", onAbort);

      if (result) return resolve(result);
      // `error` is the call's own message (already labeled); the rest are Vent's process failing.
      if (error) return reject(new Error(error));
      reject(new Error(`Vent failed, agent not tested: ${killReason ?? `call process exited (code=${code} signal=${signal})`}`));
    });
  });
}
