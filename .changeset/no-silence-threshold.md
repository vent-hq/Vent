---
"vent-hq": patch
---

Removed the `silence_threshold_ms` call option. Vent now decides when the agent has finished its turn on its own, the same way on every call, so an agent that pauses too long mid-reply shows up in the results instead of being waited out. Configs that still set it keep working; the field is ignored.
