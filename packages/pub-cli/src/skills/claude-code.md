## Claude Code Execution

Use a 5-minute shell-tool timeout (`300000` ms) on Vent run commands so normal calls are not killed by the default 2-minute Bash timeout. This is not backgrounding; wait for stdout/results before ending your response. Use the JSON returned by `npx vent-hq run` directly.

Claude Code serializes separate Bash tool calls for `npx vent-hq ...`, so run multiple calls from one suite by invoking each named call with `--call <name>` in one Bash command using `&` and a final `wait`:

```bash
npx vent-hq run -f .vent/suite.vapi.json --call happy-path & \
npx vent-hq run -f .vent/suite.vapi.json --call tool-path & \
wait
```

For locally-run LiveKit agents, run the required restart (`kill workers → start fresh worker → wait 60s`) as **one foreground Bash call**, then `npx vent-hq run` as the next Bash call. Do not use `Monitor` or `run_in_background: true` for the wait. Both end the turn until an event fires, which means Vent never sees an inflight call and the user reads it as "you backgrounded the test." The harness also blocks bare `sleep 60` (any long leading sleep), so fold the readiness check and the wait into a single `until`-loop — short sleeps inside a polling loop are allowed because each iteration is real work:

```bash
nohup npm run dev > /tmp/lk-agent.log 2>&1 &
start=$(date +%s); \
until grep -q "registered worker" /tmp/lk-agent.log 2>/dev/null \
  && [ $(($(date +%s) - start)) -ge 60 ]; do sleep 2; done
```

Give that call a **10-minute** Bash timeout (`600000` ms), since startup plus the 60s wait can run long.
