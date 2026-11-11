---
"vent-hq": minor
"@vent-hq/livekit": minor
---

Call results are leaner and show more of what matters. `latency` is mean, p50, max and first response time. `signal_quality` shows `mean_snr_db` and `max_clipping_ratio`. `tool_calls.names` and the run-level `aggregate` are removed: they repeated other fields. Zero-cost categories are left out of the cost breakdown. Cost is one `call_metadata.cost` object: the provider's `total_usd`, plus `breakdown` in the provider's own categories when it splits the cost; `cost_usd` and `cost_breakdown` are gone. Bland cost is now Bland's reported price instead of an estimate. `provider_debug_urls` is in the default output and links to the call in the Vapi, ElevenLabs or LiveKit Cloud dashboard. In `@vent-hq/livekit`, call metadata takes `cost: { total_usd, breakdown? }` instead of `cost_usd` and `cost_breakdown`.
