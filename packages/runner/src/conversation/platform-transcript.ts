import type { PlatformUtterance } from "@vent/adapters";
import type { PlatformTurn } from "@vent/shared";

// The platform's own record of the call, one entry per turn. Platforms split a
// turn into pieces (at pauses, around tool calls), so consecutive pieces from
// the same speaker are joined; empty pieces are dropped.
export function buildPlatformTranscript(utterances: PlatformUtterance[]): PlatformTurn[] {
  const turns: PlatformTurn[] = [];
  for (const u of utterances) {
    const text = u.text.trim();
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last?.role === u.role) last.text = `${last.text} ${text}`;
    else turns.push({ role: u.role, text });
  }
  return turns;
}
