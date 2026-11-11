import test from "node:test";
import assert from "node:assert/strict";
import { RetellAudioChannel } from "../src/platforms/retell.js";

test("Retell call data that cannot be fetched is reported, not returned as empty data", async () => {
  const channel = new RetellAudioChannel({ apiKey: "test-key", agentId: "test-agent" });
  Object.defineProperty(channel, "callId", { value: "call-test" });
  Object.defineProperty(channel, "fetchCallResponse", { value: async () => null });

  assert.deepEqual(await channel.getCallData(), []);
  const metadata = await channel.getCallMetadata();
  assert.equal(metadata?.provider_call_id, "call-test");
  assert.equal(metadata?.provider_warnings?.[0]?.code, "call_data_unavailable");
  assert.match(metadata?.provider_warnings?.[0]?.message ?? "", /could not fetch Retell's call data/);
});
