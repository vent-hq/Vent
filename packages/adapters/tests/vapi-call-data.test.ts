import test from "node:test";
import assert from "node:assert/strict";
import { VapiAudioChannel } from "../src/vapi-audio-channel.js";

function channelWithCallData(callData: Record<string, unknown> | null): VapiAudioChannel {
  const channel = new VapiAudioChannel({ apiKey: "test-key", assistantId: "test-assistant" });
  Object.defineProperty(channel, "callId", { value: "call-test" });
  Object.defineProperty(channel, "cachedCallResponse", { value: callData, writable: true });
  Object.defineProperty(channel, "fetchCallResponse", { value: async () => callData });
  return channel;
}

test("Vapi call data that cannot be fetched is reported, not returned as empty data", async () => {
  const channel = channelWithCallData(null);

  assert.deepEqual(await channel.getCallData(), []);
  const metadata = await channel.getCallMetadata();
  assert.equal(metadata?.provider_call_id, "call-test");
  assert.equal(metadata?.provider_warnings?.[0]?.code, "call_data_unavailable");
  assert.match(metadata?.provider_warnings?.[0]?.message ?? "", /could not fetch Vapi's call data/);
});

test("Vapi results come from the call's post-call data", async () => {
  const channel = channelWithCallData({
    id: "call-test",
    status: "ended",
    endedReason: "assistant-ended-call",
    costBreakdown: { total: 0.12 },
    artifact: {
      messages: [
        { role: "bot", message: "Hi, how can I help?", secondsFromStart: 1 },
        { role: "user", message: "I need an inspection.", secondsFromStart: 4 },
        {
          role: "tool_calls",
          secondsFromStart: 6,
          toolCalls: [{ id: "tool-1", type: "function", function: { name: "check_availability", arguments: "{\"day\":\"Tuesday\"}" } }],
        },
        { role: "tool_call_result", toolCallId: "tool-1", result: "{\"slots\":[\"2pm\"]}", secondsFromStart: 6.5 },
        { role: "bot", message: "Tuesday at 2pm works.", secondsFromStart: 8 },
        { role: "user", message: "Great, thanks.", secondsFromStart: 11 },
      ],
      performanceMetrics: {
        turnLatencies: [
          { transcriberLatency: 300, modelLatency: 700, voiceLatency: 250 },
          { transcriberLatency: 280, modelLatency: 650, voiceLatency: 240 },
        ],
      },
    },
  });

  const [toolCall] = await channel.getCallData();
  assert.equal(toolCall?.name, "check_availability");
  assert.deepEqual(toolCall?.arguments, { day: "Tuesday" });
  assert.deepEqual(toolCall?.result, { slots: ["2pm"] });
  assert.equal(toolCall?.successful, true);
  assert.equal(toolCall?.latency_ms, 500);

  assert.deepEqual(channel.getComponentTimings(), [
    { stt_ms: 300, llm_ms: 700, tts_ms: 250 },
    { stt_ms: 280, llm_ms: 650, tts_ms: 240 },
  ]);
  assert.deepEqual(channel.getTranscripts(), [
    { turnIndex: 0, text: "I need an inspection." },
    { turnIndex: 1, text: "Great, thanks." },
  ]);

  const metadata = await channel.getCallMetadata();
  assert.equal(metadata?.ended_reason, "assistant-ended-call");
  assert.equal(metadata?.cost_usd, 0.12);
  assert.equal(metadata?.provider_warnings, undefined);
});
