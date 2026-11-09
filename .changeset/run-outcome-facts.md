---
"vent-hq": patch
---

The exit code now follows the run status (0 = passed, 1 = failed or cancelled). If a call result never reaches the stream, the CLI shows the stored result instead of an empty list. Call results include `end_note` when Vent ended the call or the connection closed.
