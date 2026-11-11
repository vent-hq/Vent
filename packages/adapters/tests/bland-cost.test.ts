import test from "node:test";
import assert from "node:assert/strict";
import { buildBlandCallMetadata, type BlandCallResponse } from "../src/platforms/bland-call-data.js";

test("Bland cost is the price Bland reports, with no breakdown", () => {
  const metadata = buildBlandCallMetadata({ call_id: "call-test", price: 0.068 } as BlandCallResponse, null);
  assert.deepEqual(metadata.cost, { total_usd: 0.068 });
});

test("Bland cost is absent when Bland reports no price", () => {
  const metadata = buildBlandCallMetadata({ call_id: "call-test" } as BlandCallResponse, null);
  assert.equal(metadata.cost, undefined);
});
