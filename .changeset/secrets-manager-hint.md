---
"vent-hq": patch
---

The agent skill files say to wrap Vent commands with your secrets manager (e.g. `doppler run -- npx vent-hq run …`). Missing-credential errors now name every place the CLI looks.
