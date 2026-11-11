## Codex Execution

Use a 5-minute shell-tool timeout (`300000` ms) on Vent run commands so normal calls are not killed by the default 2-minute Bash timeout. This is not backgrounding; wait for stdout/results before ending your response. Use the JSON returned by `npx vent-hq run` directly.

Codex can run shell tool calls concurrently — for multiple calls from one suite, run each named call as its own parallel shell tool call (do not combine them with `&`):

```bash
npx vent-hq run -f .vent/suite.vapi.json --call happy-path
npx vent-hq run -f .vent/suite.vapi.json --call tool-path
```
