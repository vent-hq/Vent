## Windsurf Execution

Vent calls typically take 30 seconds to 2 minutes. Each `vent-hq run` is one shell tool call — wait for stdout (the JSON result) before responding. Don't background; use the JSON returned by `npx vent-hq run` directly. If Cascade's auto-execution level prompts for approval on `npx vent-hq` commands, ask the user to add `npx vent-hq *` to the workspace allow list once so subsequent calls flow without interruption.

Cascade runs shell tool calls in parallel within a turn — for multiple calls from one suite, issue each named call as its own separate shell tool call in the same turn (do not combine them with `&` and `wait`):

```bash
npx vent-hq run -f .vent/suite.vapi.json --call happy-path
npx vent-hq run -f .vent/suite.vapi.json --call tool-path
```

Stay within Cascade's per-turn parallel-tool-call budget — fan out at most ~6 calls in one turn and respect the provider concurrency caps below.
