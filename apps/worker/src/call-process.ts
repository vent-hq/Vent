// Child process entry: runs exactly one call, then exits.
//
// The parent (call-supervisor.ts) owns BullMQ, Postgres, Redis and the API
// callbacks. This process only places the call and reports back over IPC, so
// it can be killed at any moment without leaving half-written state behind.

import { executeCall } from "@vent/runner/executor";
import type { ChildMessage, ParentMessage } from "./call-messages.js";

const abort = new AbortController();
let started = false;

function send(message: ChildMessage): Promise<void> {
  return new Promise((resolve) => {
    if (!process.connected) return resolve();
    process.send!(message, () => resolve());
  });
}

// The parent decides when this call stops: deploy signals go to the parent,
// which sends `cancel` (and kills this process if it doesn't stop in time).
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});

// The parent died, so nobody can report this call: hang up and exit.
process.on("disconnect", () => {
  abort.abort();
  setTimeout(() => process.exit(1), 5_000).unref();
});

process.on("message", (message: ParentMessage) => {
  switch (message.type) {
    case "start":
      if (started) return;
      started = true;
      void run(message.call);
      break;
    case "cancel":
      abort.abort(message.reason);
      break;
    case "ping":
      void send({ type: "pong" });
      break;
  }
});

async function run(call: Extract<ParentMessage, { type: "start" }>["call"]): Promise<void> {
  try {
    const result = await executeCall({
      ...call,
      signal: abort.signal,
      onCallComplete: (conversation) => send({ type: "call_complete", result: conversation }),
    });
    await send({ type: "result", result });
    process.exit(0);
  } catch (err) {
    await send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}
