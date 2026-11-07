import { writeFileSync } from "node:fs";
import { formatConversationResult, type FormattedConversationResult } from "@vent/shared";
import type { SSEEvent } from "./sse.js";

const isTTY = process.stdout.isTTY;

/**
 * Synchronous write to stdout. On POSIX, process.stdout.write() to a pipe is
 * ASYNC — if the process exits before the buffer drains, the data is lost and
 * the coding agent sees "undefined". writeFileSync to /dev/stdout bypasses
 * Node's stream buffering and writes synchronously (like shell `echo`).
 */
function stdoutSync(data: string): void {
  if (isTTY) {
    process.stdout.write(data);
  } else {
    try {
      // Write directly to fd 1 — no path resolution, no new fd.
      // This is the most reliable synchronous stdout write on POSIX.
      writeFileSync(1, data);
    } catch {
      process.stdout.write(data);
    }
  }
}

export function writeJsonStdout(value: unknown): void {
  stdoutSync(JSON.stringify(value, null, 2) + "\n");
}

// ANSI helpers
const bold = (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const green = (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s: string) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s);
const yellow = (s: string) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s);
const blue = (s: string) => (isTTY ? `\x1b[34m${s}\x1b[0m` : s);

interface RunSummaryJsonOptions {
  runId: string;
  /** Run-level status from /runs/:id ("queued" | "running" | "pass" | "fail" |
   *  "cancelled"). Surfaced in the JSON envelope so coding agents can read
   *  pass/fail without having to walk into every call. */
  status?: unknown;
  total?: unknown;
  /** Convenience: passed/failed counts so the agent doesn't have to recompute. */
  passed?: unknown;
  failed?: unknown;
  formattedCalls?: Array<FormattedConversationResult | Record<string, unknown>>;
  rawCalls?: unknown[];
  verbose?: boolean;
  runDetails?: {
    created_at?: unknown;
    started_at?: unknown;
    finished_at?: unknown;
    duration_ms?: unknown;
    error_text?: unknown;
    aggregate?: unknown;
  };
}

export function printEvent(event: SSEEvent): void {
  // Non-TTY (coding agents): don't write individual events to stdout.
  // Coding agents read all stdout at once when the process exits.
  // printSummary writes one clean summary JSON at the end.
  if (!isTTY) return;

  const meta = (event.metadata_json ?? {}) as Record<string, unknown>;

  switch (event.event_type) {
    case "call_completed":
      printCallResult(meta);
      break;
    case "run_complete":
      printRunComplete(meta);
      break;
    case "call_started": {
      const name = (meta.call_name as string) ?? "call";
      stdoutSync(dim(`  ▸ ${name}…`) + "\n");
      break;
    }
    default:
      stdoutSync(dim(`  [${event.event_type}]`) + "\n");
  }
}

function printCallResult(meta: Record<string, unknown>): void {
  const result = meta.result as FormattedConversationResult | undefined;

  const callName = result?.name ?? (meta.call_name as string) ?? "call";
  const callStatus = result?.status ?? (meta.status as string);
  const durationMs = result?.duration_ms ?? (meta.duration_ms as number | undefined);

  // Pipeline-completion icon only (not a mission-success verdict).
  const statusIcon = callStatus === "completed" ? green("●") : red("●");
  const duration = durationMs != null ? (durationMs / 1000).toFixed(1) + "s" : "—";

  const parts = [statusIcon, bold(callName), dim(duration)];

  if (result?.latency?.response_time_ms != null) {
    parts.push(`mean: ${Math.round(result.latency.response_time_ms)}ms`);
  }

  if (result?.call_metadata?.transfer_attempted) {
    const transferLabel = result.call_metadata.transfer_completed ? "transfer: completed" : "transfer: attempted";
    parts.push(transferLabel);
  }

  stdoutSync(parts.join("  ") + "\n");

  const providerCallId = result?.call_metadata?.provider_call_id;
  const providerSessionId = result?.call_metadata?.provider_session_id;
  if (providerCallId) {
    stdoutSync(dim(`    provider id: ${providerCallId}`) + "\n");
  } else if (providerSessionId) {
    stdoutSync(dim(`    provider session: ${providerSessionId}`) + "\n");
  }

  const recordingUrl = result?.call_metadata?.recording_url;
  if (recordingUrl) {
    stdoutSync(dim(`    recording: ${recordingUrl}`) + "\n");
  }

  const debugUrls = result?.call_metadata?.provider_debug_urls;
  if (debugUrls) {
    for (const [label, url] of Object.entries(debugUrls)) {
      stdoutSync(dim(`    ${label}: ${url}`) + "\n");
    }
  }
}

function printRunComplete(meta: Record<string, unknown>): void {
  const agg = meta.aggregate as { conversation_calls?: { total?: number } } | undefined;
  const counts = agg?.conversation_calls;
  const total = (meta.total_calls as number | undefined) ?? counts?.total;

  stdoutSync("\n");
  stdoutSync(bold("Run complete") + dim(" — Vent does not judge mission success; review the calls above.") + "\n");

  if (total != null) {
    stdoutSync(`${total} call${total === 1 ? "" : "s"} ran\n`);
  }
}

export function printSummary(
  callResults: SSEEvent[],
  runComplete: Record<string, unknown>,
  runId: string,
  options: {
    verbose?: boolean;
    rawCalls?: unknown[];
    runDetails?: RunSummaryJsonOptions["runDetails"];
  } = {},
): void {
  const allCalls = options.rawCalls
    ? formatRawCalls(options.rawCalls, options.verbose ?? false)
    : callResults.map((e) => {
      const meta = e.metadata_json ?? {};
      const r = meta.result as FormattedConversationResult | undefined;
      if (r) return r;
      // Fallback for events without a full result object
      return {
        name: (meta.call_name as string) ?? "call",
        status: (meta.status as string) ?? "unknown",
        duration_ms: meta.duration_ms as number,
        error: null,
      };
    });

  const agg = runComplete.aggregate as { conversation_calls?: { passed?: number; failed?: number; total?: number } } | undefined;
  const counts = agg?.conversation_calls;
  const summaryData = buildRunSummaryJson({
    runId,
    total: runComplete.total_calls ?? counts?.total,
    formattedCalls: allCalls,
    verbose: options.verbose,
    runDetails: options.runDetails ?? { aggregate: runComplete.aggregate },
  });

  // Non-TTY (coding agents): write single summary JSON to stdout.
  if (!isTTY) {
    stdoutSync(JSON.stringify(summaryData, null, 2) + "\n");
    return;
  }

  // TTY: list pipeline-errored calls with details
  const errored = allCalls.filter((t) => t.status && t.status !== "completed");

  if (errored.length > 0) {
    stdoutSync("\n" + bold("Pipeline errors:") + "\n");
    for (const t of errored) {
      const ms = typeof t.duration_ms === "number" ? t.duration_ms : null;
      const duration = ms != null ? (ms / 1000).toFixed(1) + "s" : "—";
      const name = typeof t.name === "string" ? t.name : "call";
      const parts = [red("●"), bold(name), dim(duration)];
      stdoutSync("  " + parts.join("  ") + "\n");
    }
  }

  stdoutSync(dim(`Run ID: ${runId}`) + "\n");
}

export function buildRunSummaryJson(options: RunSummaryJsonOptions): Record<string, unknown> {
  const calls = options.rawCalls
    ? formatRawCalls(options.rawCalls, options.verbose ?? false)
    : (options.formattedCalls ?? []);

  const summaryData: Record<string, unknown> = {
    run_id: options.runId,
    ...(options.status != null ? { status: options.status } : {}),
    total: options.total,
    ...(options.passed != null ? { passed: options.passed } : {}),
    ...(options.failed != null ? { failed: options.failed } : {}),
    calls,
  };

  const details = options.runDetails;
  if (details?.created_at != null) summaryData["created_at"] = details.created_at;
  if (details?.started_at != null) summaryData["started_at"] = details.started_at;
  if (details?.finished_at != null) summaryData["finished_at"] = details.finished_at;
  if (details?.duration_ms != null) summaryData["duration_ms"] = details.duration_ms;
  if (details?.error_text != null) summaryData["error_text"] = details.error_text;
  if (details?.aggregate != null) {
    // Strip pass/fail counts: they imply mission-success judgment that
    // belongs to the coding agent, not Vent. Keep aggregate metadata
    // (totals, durations, costs) by recursively walking the object.
    summaryData["aggregate"] = stripPassFailFromAggregate(details.aggregate);
  }

  return summaryData;
}

function stripPassFailFromAggregate(aggregate: unknown): unknown {
  if (!aggregate || typeof aggregate !== "object" || Array.isArray(aggregate)) return aggregate;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(aggregate as Record<string, unknown>)) {
    if (k === "conversation_calls" && v && typeof v === "object") {
      const cc = v as Record<string, unknown>;
      const filtered: Record<string, unknown> = {};
      for (const [ck, cv] of Object.entries(cc)) {
        if (ck === "passed" || ck === "failed") continue;
        filtered[ck] = cv;
      }
      out[k] = filtered;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function formatRawCalls(
  rawCalls: unknown[],
  verbose: boolean,
): Array<FormattedConversationResult | Record<string, unknown>> {
  return rawCalls.map((raw) => {
    const formatted = formatConversationResult(raw, { verbose });
    if (formatted) return formatted;

    const fallback = raw as Record<string, unknown>;
    return {
      name: typeof fallback["name"] === "string" ? fallback["name"] : "call",
      status: typeof fallback["status"] === "string" ? fallback["status"] : "unknown",
      duration_ms: typeof fallback["duration_ms"] === "number" ? fallback["duration_ms"] : undefined,
      error: typeof fallback["error"] === "string" ? fallback["error"] : null,
    };
  });
}

export function printError(message: string): void {
  const line = red(bold("error")) + ` ${message}\n`;
  stdoutSync(line);
}

export function printInfo(message: string, { force }: { force?: boolean } = {}): void {
  if (!force && !isTTY) return;
  const line = blue("▸") + ` ${message}\n`;
  stdoutSync(line);
}

export function printSuccess(message: string, { force }: { force?: boolean } = {}): void {
  if (!force && !isTTY) return;
  const line = green("✔") + ` ${message}\n`;
  stdoutSync(line);
}

export function printWarn(message: string, { force }: { force?: boolean } = {}): void {
  if (!force && !isTTY) return;
  const line = yellow("⚠") + ` ${message}\n`;
  stdoutSync(line);
}
