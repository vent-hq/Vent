import test from "node:test";
import assert from "node:assert/strict";
import { ventEventMetadata } from "../src/shared/vent-events.js";

test("vent:call-metadata keeps valid agent-reported transfers and drops malformed ones", () => {
  const metadata = ventEventMetadata("vent:call-metadata", {
    call_metadata: {
      transfers: [
        { type: "warm_transfer", destination: "+15550100", status: "completed", sources: ["platform_event"] },
        { type: "cold_transfer", status: "done", sources: [] },
      ],
    },
  }, "livekit");

  assert.deepEqual(metadata?.transfers, [
    { type: "warm_transfer", destination: "+15550100", status: "completed", sources: ["platform_event"] },
  ]);
});
