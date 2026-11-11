import test from "node:test";
import assert from "node:assert/strict";
import { ElevenLabsAudioChannel } from "../src/platforms/elevenlabs.js";

async function metadata(value: Record<string, unknown>) {
  const channel = new ElevenLabsAudioChannel({ apiKey: "test-key", agentId: "test-agent" });
  Object.defineProperty(channel, "fetchConversation", {
    value: async () => ({conversationId:"test-conversation",metadata:value}),
  });
  return channel.getCallMetadata();
}

test("ElevenLabs credit charges are retained without being reported as dollars", async () => {
  const result = await metadata({cost:665});
  assert.equal(result?.cost_usd, undefined);
  assert.equal(result?.provider_metadata?.cost_credits, 665);
});

test("ElevenLabs uses the fiat cost field when dollars are available", async () => {
  const result = await metadata({cost:665,costFiat:0.0665});
  assert.equal(result?.cost_usd, 0.0665);
  assert.equal(result?.provider_metadata?.cost_credits, 665);
});
