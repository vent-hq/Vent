---
"vent-hq": minor
---

Requires Node.js 22 or newer: `vent-hq agent start` uses the built-in `WebSocket`, which Node 20 only provides behind a flag.

`--help` / `-h` now works for every command: `vent-hq <command> --help` prints that command's usage instead of running it (previously `init --help` ran init, `logout --help` logged out, and `login --help` / `agent start --help` failed with "unknown option"). Every command reports missing credentials with the same message. A Bland config with only `persona_id` is now rejected before submitting (it needs `bland_pathway_id` or `task`), matching what the API already required. Saved run history in `.vent/runs/` no longer stores `calls_passed` / `calls_failed`. Skill file fixes: results have no `emotion` field, and `max_turns` is optional (defaults to 6).
