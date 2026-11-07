import * as fs from "node:fs/promises";
import type { PlatformConfig } from "@vent/shared";
import { apiFetch, ApiError, ensurePlatformConnection } from "../lib/api.js";
import { streamRunEvents } from "../lib/sse.js";
import { printEvent, printError, printInfo, printSummary, printWarn } from "../lib/output.js";
import { loadAccessToken } from "../lib/config.js";
import { saveRunHistory } from "../lib/run-history.js";
import { resolveRemotePlatformConfig } from "../lib/platform-config.js";
import type { SSEEvent } from "../lib/sse.js";

const isTTY = process.stdout.isTTY;

interface RunArgs {
  file: string;
  call?: string;
  session?: string;
  verbose?: boolean;
}

export async function runCommand(args: RunArgs): Promise<number> {
  // 1. Resolve Vent access token
  const accessToken = await loadAccessToken();
  if (!accessToken) {
    printError("No Vent access token found. Set VENT_ACCESS_TOKEN, run `npx vent-hq login`, or pass --access-token.");
    return 2;
  }

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

  // 2b. Resolve remote platform credentials from local env and keep them local to the CLI.
  // The CLI will upsert a saved platform connection and submit only the resulting ID.
  let resolvedRemotePlatform: PlatformConfig | null = null;
  try {
    resolvedRemotePlatform = resolveRemotePlatformConfig(config);
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

  let activeAccessToken = accessToken;
  const configConnection = config as {
    connection?: {
      adapter?: string;
      platform?: Record<string, unknown>;
      platform_connection_id?: string;
    };
  };

  async function prepareConfigForSubmit(currentAccessToken: string): Promise<void> {
    if (!configConnection.connection) return;

    if (resolvedRemotePlatform) {
      const ensured = await ensurePlatformConnection(currentAccessToken, resolvedRemotePlatform);
      configConnection.connection.platform_connection_id = ensured.platform_connection_id;
    }

    if ("platform" in configConnection.connection) {
      delete configConnection.connection.platform;
    }
  }

  async function submitPrepared(currentAccessToken: string): Promise<typeof submitResult> {
    await prepareConfigForSubmit(currentAccessToken);
    const res = await apiFetch("/runs/submit", currentAccessToken, {
      method: "POST",
      body: JSON.stringify({
        config,
        agent_session_id: args.session,
      }),
    });
    return res.json() as Promise<typeof submitResult>;
  }

  try {
    submitResult = await submitPrepared(activeAccessToken);
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
  printInfo(`Run ${run_id} created.`);

  // 4. Stream results
  printInfo(`Streaming results for run ${run_id}…`);
  const abortController = new AbortController();
  let exitCode = 0;
  const callResults: SSEEvent[] = [];
  let runCompleteData: Record<string, unknown> | null = null;

  // Fire-and-forget cancel POST when the user hits Ctrl+C / receives SIGTERM.
  // Without this, aborting the SSE stream leaves the worker running the call
  // to completion — the platform keeps billing for a call no one is listening
  // to. Best-effort: 5s timeout, errors swallowed; if the stop POST fails the
  // stuck-run cleanup eventually catches it (much later, after the call ends).
  let stopRequested = false;
  // Tracked so we can `await` the stop POST before process.exit. Without this,
  // the SSE abort + immediate exit may kill the request before the TCP
  // handshake completes, leaving the worker running and the platform billing.
  let stopPromise: Promise<unknown> | null = null;
  const onSignal = () => {
    if (!stopRequested) {
      stopRequested = true;
      stopPromise = apiFetch(`/runs/${run_id}/stop`, activeAccessToken, {
        method: "POST",
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {});
    }
    abortController.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    for await (const event of streamRunEvents(run_id, activeAccessToken, abortController.signal)) {
      const meta = (event.metadata_json ?? {}) as Record<string, unknown>;
      printEvent(event);

      if (event.event_type === "call_completed") {
        callResults.push(event);
      }

      if (event.event_type === "run_complete") {
        runCompleteData = meta;
        // Exit code reflects pipeline completion only, not mission success.
        // 0 = every call ran end-to-end through the pipeline; 1 = at least
        // one call errored at the pipeline level; 2 = harness error (set
        // elsewhere). Mission success is the coding agent's judgment from
        // the transcript — not something Vent claims to know.
        const anyCallErrored = callResults.some((e) => {
          const callMeta = (e.metadata_json ?? {}) as Record<string, unknown>;
          const callStatus = callMeta["status"];
          return callStatus === "error";
        });
        exitCode = anyCallErrored ? 1 : 0;
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

  // 5. Print summary
  if (runCompleteData) {
    let rawRunDetails: Record<string, unknown> | null = null;
    if (args.verbose && !isTTY) {
      try {
        const res = await apiFetch(`/runs/${run_id}`, activeAccessToken);
        rawRunDetails = (await res.json()) as Record<string, unknown>;
      } catch {
        printWarn("Verbose result fetch failed; falling back to streamed summary.");
      }
    }

    printSummary(callResults, runCompleteData, run_id, {
      verbose: args.verbose,
      rawCalls: Array.isArray(rawRunDetails?.["results"]) ? rawRunDetails["results"] as unknown[] : undefined,
      runDetails: rawRunDetails ? {
        created_at: rawRunDetails["created_at"],
        started_at: rawRunDetails["started_at"],
        finished_at: rawRunDetails["finished_at"],
        duration_ms: rawRunDetails["duration_ms"],
        error_text: rawRunDetails["error_text"],
        aggregate: rawRunDetails["aggregate"],
      } : undefined,
    });
  }

  // 6. Save run history locally
  if (runCompleteData) {
    const savedPath = await saveRunHistory(run_id, callResults, runCompleteData);
    if (savedPath) {
      printInfo(`Run saved to ${savedPath}`);
    }
  }

  // If a SIGINT/SIGTERM kicked off a stop POST, wait for it to finish
  // (or its 5s timeout to fire) before exiting. Without this `await`,
  // process.exit can race the in-flight TCP handshake and the stop is
  // never sent — worker keeps running, platform keeps billing.
  if (stopPromise) {
    await stopPromise;
  }

  // Force exit — the fetch TCP socket from the SSE stream keeps the event loop
  // alive indefinitely. Without this, the process hangs after calls complete,
  // Claude Code eventually kills it, and stdout capture is lost.
  process.exit(exitCode);
}
