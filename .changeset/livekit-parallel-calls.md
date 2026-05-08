---
"vent-hq": patch
---

Document parallel LiveKit call support in skill files. Coding agents now receive guidance on deriving `platform.max_concurrency` from the user's LiveKit plan, agent worker box capacity, and STT/TTS provider concurrency limits — rather than the previous instruction to run LiveKit calls sequentially.
