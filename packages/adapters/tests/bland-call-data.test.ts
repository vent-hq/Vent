import test from "node:test";
import assert from "node:assert/strict";
import { buildBlandTranscripts, parseBlandToolCalls, type BlandPathwayEvent } from "../src/platforms/bland-call-data.js";

const event = (sequence: number, event_type: string, payload: Record<string, unknown>, operation_id: number | null = null): BlandPathwayEvent => ({
  sequence, event_type, node_id: "webhook_lookup_customer", operation_id, payload, created_at: `2026-11-10T09:30:${20 + sequence}.000Z`,
});

const call = { call_id: "call-test", status: "completed", started_at: "2026-11-10T09:30:20.000Z", pathway_id: "pw" };

test("pathway webhooks come from the event timeline with arguments, result, status and duration", () => {
  const events = [
    event(1, "transcript.user", { text: "Look up James Chen." }),
    event(2, "webhook.invoke", { url: "https://x/lookup", method: "POST", body: { name: "James Chen" } }),
    event(3, "webhook.result", { url: "https://x/lookup", status: 200, body: { customer: { id: "C002" } }, duration_ms: 345 }, 2),
    event(4, "webhook.invoke", { url: "https://x/book", method: "POST", tool_name: "book", body: { slot: "3pm" } }),
    event(5, "webhook.result", { url: "https://x/book", status: 500, body: { error: "db down" }, duration_ms: 12 }, 4),
    event(6, "tool.invoke", { tool_name: "cancel", tool_type: "API", input_variables: { id: "B1" } }),
    event(7, "tool.error", { message: "timed out" }, 6),
    event(8, "transcript.assistant", { text: "Your number is", generated_response: "Your number is 555-0102." }),
    // Real events: a node's fixed message before a webhook, then the LLM's reply after it.
    event(9, "transcript.assistant", {
      text: "Checking available time slots now.",
      generated_response: "I found some availability for Thursday, November twelfth.",
    }),
  ];
  assert.deepEqual(parseBlandToolCalls(call, events), [
    { name: "webhook_lookup_customer", arguments: { name: "James Chen" }, result: { customer: { id: "C002" } }, successful: true, provider_tool_type: "webhook", timestamp_ms: 2000, latency_ms: 345 },
    { name: "book", arguments: { slot: "3pm" }, result: { error: "db down" }, successful: false, provider_tool_type: "webhook", timestamp_ms: 4000, latency_ms: 12 },
    { name: "cancel", arguments: { id: "B1" }, result: "timed out", successful: false, provider_tool_type: "API", timestamp_ms: 6000, latency_ms: undefined },
  ]);
  // What the agent's LLM wrote: the full sentence when cut off, and both parts around a webhook.
  assert.deepEqual(buildBlandTranscripts(call, events), [
    { role: "caller", text: "Look up James Chen." },
    { role: "agent", text: "Your number is 555-0102." },
    { role: "agent", text: "Checking available time slots now. I found some availability for Thursday, November twelfth." },
  ]);
});
