import test from "node:test";
import assert from "node:assert/strict";
import type { ConversationTurn, ObservedToolCall } from "@vent/shared";
import { matchToolCallsToTurns } from "../src/metrics/tool-calls.js";

// Agent turns are stamped when they finish.
const turns: ConversationTurn[] = [
  { role: "agent", text: "Hi, how can I help?", timestamp_ms: 8_000 },
  { role: "caller", text: "Look up my account.", timestamp_ms: 14_000 },
  { role: "agent", text: "Let me check. Found it.", timestamp_ms: 30_000 },
  { role: "caller", text: "Any slots Thursday?", timestamp_ms: 36_000 },
];

const call = (name: string, timestamp_ms: number): ObservedToolCall => ({ name, arguments: {}, timestamp_ms });

test("a tool call goes on the agent turn it ran in, not the one before", () => {
  const toolCalls = [
    call("lookup_customer", 15_000), // after the caller's question, before the reply finished
    call("check_availability", 37_000), // the agent never replied after it
  ];
  matchToolCallsToTurns(toolCalls, turns);
  assert.equal(toolCalls[0]!.turn_index, 2);
  assert.equal(toolCalls[1]!.turn_index, 3);
});
