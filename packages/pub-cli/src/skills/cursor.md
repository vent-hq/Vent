## Cursor Execution

Use a 5-minute shell-tool timeout (`300000` ms) on Vent run commands so normal calls are not killed by the default 2-minute Bash timeout. This is not backgrounding; wait for stdout/results before ending your response. Use the JSON returned by `npx vent-hq run` directly.

Cursor cannot run separate shell tool calls concurrently — for multiple calls from one suite, invoke each named call with `--call <name>` in one shell command using `&` and a final `wait`:

```bash
npx vent-hq run -f .vent/suite.vapi.json --call happy-path & \
npx vent-hq run -f .vent/suite.vapi.json --call tool-path & \
wait
```
