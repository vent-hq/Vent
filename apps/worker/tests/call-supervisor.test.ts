import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExecuteCallResult } from "@vent/runner/executor";
import type { CallInput } from "../src/call-messages.js";
import { runCallInProcess } from "../src/call-supervisor.js";

// Stand-in call processes speaking the same IPC protocol as call-process.ts.
const dir = mkdtempSync(path.join(tmpdir(), "vent-call-process-"));
function childScript(name: string, onMessage: string): string {
  const file = path.join(dir, `${name}.cjs`);
  writeFileSync(file, `process.on("message", (m) => { ${onMessage} });\n`);
  return file;
}

const result = { status: "pass", conversationResult: { name: "booking" }, aggregate: {} } as unknown as ExecuteCallResult;
const call = { runId: "run-1", callSpec: {}, channelConfig: { adapter: "vapi" } } as unknown as CallInput;
const fast = { cancelGraceMs: 300, pingTimeoutMs: 600, timeoutMs: 60_000 };

const completes = childScript("completes", `
  if (m.type === "ping") process.send({ type: "pong" });
  if (m.type === "start") {
    process.send({ type: "call_complete", result: { name: m.call.runId } });
    process.send({ type: "result", result: ${JSON.stringify(result)} }, () => process.exit(0));
  }`);
const crashes = childScript("crashes", `if (m.type === "start") process.exit(3);`);
const stopsOnCancel = childScript("stops-on-cancel", `
  if (m.type === "ping") process.send({ type: "pong" });
  if (m.type === "cancel") process.send({ type: "result", result: ${JSON.stringify(result)} }, () => process.exit(0));`);
const ignoresCancel = childScript("ignores-cancel", `if (m.type === "ping") process.send({ type: "pong" });`);
const blocksEventLoop = childScript("blocks-event-loop", `if (m.type === "start") for (;;) {}`);

test("a finished call resolves with the child's result and reports call progress", async () => {
  const progress: unknown[] = [];
  const out = await runCallInProcess(completes, call, {
    signal: new AbortController().signal,
    onCallComplete: (r) => { progress.push(r); },
    limits: fast,
  });
  assert.deepEqual(out, result);
  assert.deepEqual(progress, [{ name: "run-1" }]);
});

test("a call process that dies without a result fails the call", async () => {
  await assert.rejects(
    runCallInProcess(crashes, call, { signal: new AbortController().signal, onCallComplete: () => {}, limits: fast }),
    /^Error: Vent failed, agent not tested: call process exited \(code=3/,
  );
});

test("a cancelled call that hangs up returns its partial result", async () => {
  const abort = new AbortController();
  const running = runCallInProcess(stopsOnCancel, call, { signal: abort.signal, onCallComplete: () => {}, limits: fast });
  abort.abort();
  assert.deepEqual(await running, result);
});

test("a cancelled call that doesn't stop is killed after the grace period", async () => {
  const abort = new AbortController();
  const running = runCallInProcess(ignoresCancel, call, { signal: abort.signal, onCallComplete: () => {}, limits: fast });
  abort.abort();
  await assert.rejects(running, /^Error: Vent failed, agent not tested: the call did not stop within 0.3s of being stopped \(cancelled\)$/);
});

test("a call whose event loop is blocked is killed", async () => {
  await assert.rejects(
    runCallInProcess(blocksEventLoop, call, { signal: new AbortController().signal, onCallComplete: () => {}, limits: fast }),
    /^Error: Vent failed, agent not tested: call process unresponsive for 0.6s$/,
  );
});

test("a call that runs past the time limit is cancelled, then killed", async () => {
  await assert.rejects(
    runCallInProcess(ignoresCancel, call, {
      signal: new AbortController().signal,
      onCallComplete: () => {},
      limits: { ...fast, timeoutMs: 200 },
    }),
    /did not stop within 0.3s of being stopped \(it hit the .*-minute call limit\)$/,
  );
});
