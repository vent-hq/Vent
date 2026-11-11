/**
 * Tool calls: which turn each call belongs to.
 */

import type { ConversationTurn, ObservedToolCall } from "@vent/shared";

/**
 * Set each timed tool call's turn_index to the agent turn it ran in. Agent turns
 * are stamped when they finish, so that is the first agent turn stamped at or
 * after the call. A call after the last agent turn ran while the agent never
 * replied: it goes on the call's last turn.
 */
export function matchToolCallsToTurns(toolCalls: ObservedToolCall[], turns: ConversationTurn[]): void {
  if (turns.length === 0) return;
  for (const tc of toolCalls) {
    if (tc.timestamp_ms == null) continue;
    const index = turns.findIndex((t) => t.role === "agent" && t.timestamp_ms >= tc.timestamp_ms!);
    tc.turn_index = index >= 0 ? index : turns.length - 1;
  }
}
