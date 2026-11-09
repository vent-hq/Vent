---
"vent-hq": patch
---

`vent run` resends a submit once if the connection drops or the API is restarting, with the same idempotency key, so a lost response never starts a second call.
