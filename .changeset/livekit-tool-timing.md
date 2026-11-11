---
"@vent-hq/livekit": minor
---

Tool calls now carry `duration_ms` (how long the tool ran, from LiveKit's call and output timestamps), and the session's close reason is sent as `ended_reason`. Vent shows both: per-tool latency and why the call ended when the agent's side ended it.
