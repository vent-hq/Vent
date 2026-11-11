import test from "node:test";
import assert from "node:assert/strict";
import { buildPlatformTranscript } from "../src/conversation/platform-transcript.js";

test("pieces of one platform turn are joined into one turn", () => {
  assert.deepEqual(buildPlatformTranscript([
    { role: "agent", text: "Friday is open." },
    { role: "caller", text: "What afternoon slots are open on Friday?" },
    { role: "caller", text: "November thirteenth?" },
    { role: "agent", text: "3 to 5 PM." },
  ]), [
    { role: "agent", text: "Friday is open." },
    { role: "caller", text: "What afternoon slots are open on Friday? November thirteenth?" },
    { role: "agent", text: "3 to 5 PM." },
  ]);
});

test("empty platform pieces are dropped", () => {
  assert.deepEqual(buildPlatformTranscript([
    { role: "caller", text: "" },
    { role: "agent", text: "Hello." },
    { role: "caller", text: "Bye." },
  ]), [
    { role: "agent", text: "Hello." },
    { role: "caller", text: "Bye." },
  ]);
});
