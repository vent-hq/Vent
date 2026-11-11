import test from "node:test";
import assert from "node:assert/strict";
import { VapiAudioChannel } from "../src/platforms/vapi.js";

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
    costBreakdown: {
      total: 1.5, stt: 0.25, llm: 0.5, vapi: 0.25,
      analysisCostBreakdown: { summary: 0.25, successEvaluation: 0.25 },
    },
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

  // The tool's run time comes from the call logs, not the message timestamps.
  Object.defineProperty(channel, "toolDurations", { value: new Map([["tool-1", 302]]) });
  const [toolCall] = await channel.getCallData();
  assert.equal(toolCall?.name, "check_availability");
  assert.deepEqual(toolCall?.arguments, { day: "Tuesday" });
  assert.deepEqual(toolCall?.result, { slots: ["2pm"] });
  assert.equal(toolCall?.successful, true);
  assert.equal(toolCall?.latency_ms, 302);

  assert.deepEqual(channel.getComponentTimings(), [
    { stt_ms: 300, llm_ms: 700, tts_ms: 250 },
    { stt_ms: 280, llm_ms: 650, tts_ms: 240 },
  ]);
  const metadata = await channel.getCallMetadata();
  assert.equal(metadata?.ended_reason, "assistant-ended-call");
  // Vapi's own categories; the analysis sub-costs roll up into `analysis`. Token counts aren't dollars.
  assert.deepEqual(metadata?.cost, {
    total_usd: 1.5,
    breakdown: { stt: 0.25, llm: 0.5, vapi: 0.25, analysis: 0.5 },
  });
  assert.deepEqual(metadata?.provider_debug_urls, { dashboard: "https://dashboard.vapi.ai/calls/call-test" });
  assert.equal(metadata?.provider_warnings, undefined);
});

test("Vapi agent turns come from voice-input; the fixed first message from the assistant config", () => {
  const channel = channelWithCallData(null);
  Object.defineProperty(channel, "cachedAssistantRuntimeConfig", {
    value: { firstMessageMode: "assistant-speaks-first", firstMessage: "Hi, how can I help?" },
  });
  const send = (msg: Record<string, unknown>) =>
    (channel as unknown as { handleControlMessage(raw: string): void }).handleControlMessage(JSON.stringify(msg));
  send({ type: "transcript", role: "user", transcriptType: "partial", transcript: "Read me my" });
  send({ type: "transcript", role: "user", transcriptType: "final", transcript: "Read me my phone number." });
  send({ type: "voice-input", input: "Your number is 555-0102." });
  send({ type: "transcript", role: "assistant", transcriptType: "final", transcript: "five five five one two" });
  assert.deepEqual(channel.getTranscripts(), [
    { role: "agent", text: "Hi, how can I help?" },
    { role: "caller", text: "Read me my phone number." },
    { role: "agent", text: "Your number is 555-0102." },
  ]);
});
