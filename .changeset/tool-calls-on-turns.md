---
"vent-hq": patch
---

Tool calls are now on the agent turn that ran them: each agent turn in `transcript` has `tool_calls` (name, arguments, result, `successful`, `latency_ms`), so what the agent said sits next to what its tools returned. A tool the agent ran but never replied after is on the call's last turn. The call-level `tool_calls` summary (counts, mean latency, `observed[]`, `turn_index`) is gone; a call-level `tool_calls` list appears only for a failed call whose transcript was lost. Tool calls were also matched to the wrong turn before (the agent's previous turn), which is fixed.
