import test from "node:test";
import assert from "node:assert/strict";
import { ElevenLabsAudioChannel } from "../src/platforms/elevenlabs.js";

function channelWith(conversation: Record<string, unknown>) {
  const channel = new ElevenLabsAudioChannel({ apiKey: "test-key", agentId: "test-agent" });
  Object.defineProperty(channel, "fetchConversation", {
    value: async () => ({ conversationId: "test-conversation", transcript: [], ...conversation }),
  });
  return channel;
}

async function metadata(value: Record<string, unknown>) {
  return channelWith({ metadata: value }).getCallMetadata();
}

test("ElevenLabs credit charges are not reported as dollars", async () => {
  const result = await metadata({cost:665});
  assert.equal(result?.cost, undefined);
});

test("ElevenLabs uses the fiat cost field when dollars are available", async () => {
  const result = await metadata({cost:665,costFiat:0.0665});
  assert.deepEqual(result?.cost, { total_usd: 0.0665 });
});

test("ElevenLabs cost is split into its own LLM and platform prices", async () => {
  const result = await metadata({costFiat:0.75,charging:{llmPrice:0.25,platformPrice:0.5}});
  assert.deepEqual(result?.cost, { total_usd: 0.75, breakdown: { llm: 0.25, platform: 0.5 } });
});

test("ElevenLabs links to the conversation in its dashboard", async () => {
  const result = await metadata({});
  assert.deepEqual(result?.provider_debug_urls, { dashboard: "https://elevenlabs.io/app/agents/history/test-conversation" });
});

test("ElevenLabs tool calls, warnings and transfers come from the post-call conversation", async () => {
  const channel = channelWith({
    metadata: {
      warnings: ["Voice fell back to default"],
    },
    transcript: [
      {
        role: "agent",
        timeInCallSecs: 4,
        toolCalls: [
          { requestId: "r1", toolName: "lookup_order", paramsAsJson: "{\"id\":\"42\"}", type: "webhook" },
          { requestId: "r2", toolName: "transfer_to_number", paramsAsJson: "{\"transfer_number\":\"+15550100\"}", type: "system" },
        ],
      },
      {
        role: "agent",
        timeInCallSecs: 5,
        toolResults: [
          { requestId: "r1", toolName: "lookup_order", resultValue: "timeout", isError: true, rawErrorMessage: "HTTP 504", toolLatencySecs: 1.5 },
          { requestId: "r2", toolName: "transfer_to_number", resultValue: "{}", isError: false },
        ],
      },
    ],
  });

  const [lookup] = await channel.getCallData();
  assert.deepEqual(lookup, {
    name: "lookup_order",
    arguments: { id: "42" },
    result: "timeout",
    successful: false,
    provider_tool_type: "webhook",
    timestamp_ms: 4000,
    latency_ms: 1500,
  });

  const result = await channel.getCallMetadata();
  assert.deepEqual(result?.provider_warnings, [{ message: "Voice fell back to default" }]);
  assert.deepEqual(result?.transfers, [{
    type: "transfer_to_number",
    destination: "+15550100",
    status: "completed",
    sources: ["tool_call", "platform_metadata"],
    timestamp_ms: 4000,
  }]);
});

test("an interrupted ElevenLabs agent turn keeps its full text", () => {
  const channel = new ElevenLabsAudioChannel({ apiKey: "test-key", agentId: "test-agent" });
  Object.defineProperty(channel, "cachedConversation", {
    value: {
      transcript: [
        { role: "agent", timeInCallSecs: 1, message: "Your number is", originalMessage: "Your number is 555-0102.", interrupted: true },
        { role: "user", timeInCallSecs: 3, message: "Sorry, go on." },
      ],
    },
  });
  assert.deepEqual(channel.getTranscripts(), [
    { role: "agent", text: "Your number is 555-0102." },
    { role: "caller", text: "Sorry, go on." },
  ]);
});
