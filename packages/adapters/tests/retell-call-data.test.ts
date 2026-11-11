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

test("Retell cost keeps Retell's own product line items, in dollars", async () => {
  const channel = new RetellAudioChannel({ apiKey: "test-key", agentId: "test-agent" });
  Object.defineProperty(channel, "callId", { value: "call-test" });
  Object.defineProperty(channel, "fetchCallResponse", {
    value: async () => ({
      call_id: "call-test",
      call_cost: {
        combined_cost: 20,
        product_costs: [
          { product: "gemini_3_flash", cost: 5 },
          { product: "minimax_tts", cost: 10 },
          // The same product again, for a transfer leg.
          { product: "minimax_tts", cost: 5 },
        ],
      },
    }),
  });

  const metadata = await channel.getCallMetadata();
  assert.deepEqual(metadata?.cost, {
    total_usd: 0.2,
    breakdown: { gemini_3_flash: 0.05, minimax_tts: 0.15 },
  });
});

test("Retell stage latencies are call-level samples without the opening greeting", () => {
  const channel = new RetellAudioChannel({ apiKey: "test-key", agentId: "test-agent" });
  Object.defineProperty(channel, "cachedCallResponse", {
    // Real values from a call: the agent greets first (a fixed message: LLM 0 ms).
    value: {
      transcript_object: [{ role: "agent", content: "Hi, thanks for calling.", words: [] }],
      latency: {
        asr: { values: [282, 358] },
        llm: { values: [0, 1135, 544] },
        tts: { values: [169, 141, 124] },
      },
    },
  });

  assert.deepEqual(channel.getComponentTimings(), [
    { stt_ms: 282 }, { stt_ms: 358 },
    { llm_ms: 1135 }, { llm_ms: 544 },
    { tts_ms: 141 }, { tts_ms: 124 },
  ]);
});

test("Retell utterances are ordered by when they started, so overlapping speech doesn't split a reply", () => {
  const channel = new RetellAudioChannel({ apiKey: "test-key", agentId: "test-agent" });
  Object.defineProperty(channel, "cachedCallResponse", {
    // Real order from a call: the caller's last word is listed after the agent's reply began.
    value: {
      transcript_with_tool_calls: [
        { role: "user", content: "For next weekday ", words: [{ word: "For", start: 39.8, end: 40.1 }] },
        { role: "agent", content: "Got it, OSHA inspection ", words: [{ word: "Got", start: 44.2, end: 44.4 }] },
        { role: "user", content: "afternoon. ", words: [{ word: "afternoon.", start: 42.5, end: 45.3 }] },
        { role: "agent", content: "for next weekday afternoon.", words: [{ word: "for", start: 45.2, end: 45.4 }] },
      ],
    },
  });
  assert.deepEqual(channel.getTranscripts().map((u) => u.role), ["caller", "caller", "agent", "agent"]);
});
