import * as fs from "node:fs/promises";
import type { PlatformConfig } from "@vent/shared";
import { apiFetch, ApiError } from "../lib/api.js";
import { submitRun } from "../lib/submit-run.js";
import { stopRun } from "../lib/stop-run.js";
import { streamRunEvents } from "../lib/sse.js";
import { printEvent, printError, printInfo, printRunOutput, printStatus, printWarn } from "../lib/output.js";
import { saveRunHistory } from "../lib/run-history.js";
import { resolveRemotePlatformConfig } from "../lib/platform-config.js";
import type { RunOutput } from "@vent/shared";

const isTTY = process.stdout.isTTY;

interface RunArgs {
  file: string;
  call?: string;
  session?: string;
}

export async function runCommand(args: RunArgs): Promise<number> {
  // 2. Parse suite file and extract call
  let config: unknown;
  try {
    const raw = await fs.readFile(args.file, "utf-8");
    const suite = JSON.parse(raw) as {
      connection?: unknown;
      calls?: Record<string, unknown>;
    };

    if (!suite.connection) {
      printError("Suite file must have a `connection` object.");
      return 2;
    }
    if (!suite.calls || typeof suite.calls !== "object" || Object.keys(suite.calls).length === 0) {
      printError("Suite file must have a `calls` map with at least one named call.");
      return 2;
    }

    const callNames = Object.keys(suite.calls);
    let callName: string;

    if (args.call) {
      if (!suite.calls[args.call]) {
        printError(`Call "${args.call}" not found. Available: ${callNames.join(", ")}`);
        return 2;
      }
      callName = args.call;
    } else if (callNames.length === 1) {
      callName = callNames[0]!;
    } else {
      printError(`Suite has ${callNames.length} calls. Use --call <name> to pick one: ${callNames.join(", ")}`);
      return 2;
    }

    const call = { ...(suite.calls[callName] as Record<string, unknown>), name: callName };
    config = { connection: suite.connection, call };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      printError(`File not found: ${args.file}`);
      return 2;
    }
    printError(`Invalid suite JSON: ${(err as Error).message}`);
    return 2;
  }

  // 2b. Resolve provider settings for the API to encrypt with this run.
  try {
    const platform = resolveRemotePlatformConfig(config);
    if (platform) {
      (config as { connection: { platform?: PlatformConfig } }).connection.platform = platform;
    }
  } catch (err) {
    printError((err as Error).message);
    return 2;
  }

  const connection = config as {
    connection?: {
      start_command?: string;
      agent_url?: string;
      adapter?: string;
    };
  };
  const isLocalStartCommand = !!connection.connection?.start_command && !connection.connection?.agent_url;
  if (isLocalStartCommand && !args.session) {
    printError(
      "Local runs require --session <agent-session-id>. Start the shared relay once with `npx vent-hq agent start -f <suite.json>`.",
    );
    return 2;
  }

  // 3. Submit run
  printInfo("Submitting run…");
  let submitResult: {
    run_id: string;
    status: string;
  };

  try {
    const res = await submitRun({ config, agent_session_id: args.session });
    submitResult = await res.json() as typeof submitResult;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      printError("Access token rejected. Run `npx vent-hq login` to re-authenticate.");
      return 1;
    }
    printError(`Submit failed: ${(err as Error).message}`);
    return 2;
  }

  const { run_id } = submitResult;
  if (!run_id) {
    printError("Server returned no run_id. Response: " + JSON.stringify(submitResult));
    return 2;
  }
  // Printed now rather than with the result, so an interrupted caller can still stop the run.
  printStatus(`Run created: ${run_id}`);
  printStatus(`Stop: npx vent-hq stop ${run_id}`);

  // 4. Stream results
  printInfo("Streaming results…");
  const abortController = new AbortController();
  let exitCode = 0;
  let runOutput: RunOutput | null = null;

  // Ctrl+C / SIGTERM also stops the run: closing the stream alone would leave
  // the worker running the call, and the platform billing. Only the handler
  // sets `stop` (the `as` keeps TypeScript from assuming it stays null).
  let stop = null as ReturnType<typeof stopRun> | null;
  const onSignal = () => {
    stop ??= stopRun(run_id, AbortSignal.timeout(5_000));
    abortController.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    for await (const event of streamRunEvents(run_id, abortController.signal)) {
      printEvent(event);

      if (event.event_type === "run_complete") {
        runOutput = event.result ?? null;
      }

      if (event.event_type === "error") {
        printError(event.message ?? "Stream connection lost");
        exitCode = 2;
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      printError(`Stream error: ${(err as Error).message}`);
      exitCode = 2;
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  // 5. The stream was lost before the result arrived: read it from the run.
  if (!runOutput && !stop) {
    try {
      const res = await apiFetch(`/runs/${run_id}`);
      const stored = (await res.json()) as RunOutput;
      if (["pass", "fail", "cancelled"].includes(String(stored.status))) runOutput = stored;
    } catch {
      printWarn("Run result fetch failed.");
    }
  }

  // 6. Print the result and save it locally
  if (runOutput) {
    // Exit code reflects pipeline completion only, not mission success:
    // 0 = the run passed (the call ran end to end), 1 = it didn't (the call
    // errored, the run failed or was cancelled), 2 = no result (stream lost).
    // Mission success is the coding agent's judgment from the transcript.
    exitCode = runOutput.status === "pass" ? 0 : 1;
    printRunOutput(runOutput);
    const savedPath = await saveRunHistory(runOutput);
    if (savedPath) printInfo(`Run saved to ${savedPath}`);
  } else if (stop) {
    exitCode = 1; // cancelled
  } else if (exitCode === 0) {
    exitCode = 2;
  }

  // 7. Report the stop. Awaiting it also keeps process.exit from cutting the
  // request off before it reaches the API.
  if (stop) {
    printStatus((await stop).message);
  }

  // Force exit — the fetch TCP socket from the SSE stream keeps the event loop
  // alive indefinitely. Without this, the process hangs after calls complete,
  // Claude Code eventually kills it, and stdout capture is lost.
  process.exit(exitCode);
}
