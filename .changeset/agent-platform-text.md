---
"vent-hq": patch
---

Call results now include `platform_transcript`: the agent platform's own record of the call next to Vent's `transcript`. Its agent turns are the text the agent's LLM wrote, and its caller turns are what the agent's speech-to-text heard, so a number the voice read wrong or a word the agent misheard shows up by comparing the two. The `--verbose` per-turn `platform_transcript` field is removed. WebSocket agents can send `vent:transcript` with `role: "agent"`; `turn_index` is no longer used.
