---
"vent-hq": minor
---

`vent run` has one result format: the `--verbose` (`-v`) flag is removed. Tool results are no longer shortened, and `component_latency` keeps only the call's mean STT/LLM/TTS times. `call_metadata.variables` is removed (it repeated tool call arguments and results, plus platform bookkeeping). Removed with the verbose view: the `debug` blocks, `caller_prompt`, p90/p95/p99 and the other extra latency figures, `usage`, `recording_variants`, and the run's timestamps. The full raw result stays stored with the run.
