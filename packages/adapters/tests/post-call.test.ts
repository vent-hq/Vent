import test from "node:test";
import assert from "node:assert/strict";
import { pollUntilReady } from "../src/shared/post-call.js";

test("pollUntilReady keeps polling past errors and not-ready results until data is ready", async () => {
  const responses: Array<() => { status: string }> = [
    () => { throw new Error("temporarily unavailable"); },
    () => ({ status: "processing" }),
    () => ({ status: "ended" }),
  ];
  let calls = 0;
  const data = await pollUntilReady("test", async () => responses[calls++]!(), (d) => d.status === "ended");
  assert.deepEqual(data, { status: "ended" });
  assert.equal(calls, 3);
});
