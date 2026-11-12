import { writeFileSync } from "node:fs";
import type { FormattedConversationResult } from "@vent/shared";
import type { RunOutput } from "@vent/shared";
import type { SSEEvent } from "./sse.js";

const isTTY = process.stdout.isTTY;

/**
 * Synchronous write to stdout or stderr. On POSIX, a stream write to a pipe is
 * ASYNC — if the process exits before the buffer drains, the data is lost and
 * the coding agent sees "undefined". writeFileSync to the fd bypasses
 * Node's stream buffering and writes synchronously (like shell `echo`).
 */
function writeSync(fd: 1 | 2, data: string): void {
  const stream = fd === 1 ? process.stdout : process.stderr;
  if (stream.isTTY) {
    stream.write(data);
  } else {
    try {
      // Write directly to the fd — no path resolution, no new fd.
      // This is the most reliable synchronous write on POSIX.
      writeFileSync(fd, data);
    } catch {
      stream.write(data);
    }
  }
}

function stdoutSync(data: string): void {
  writeSync(1, data);
}

// ANSI helpers
const bold = (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const green = (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s: string) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s);
const yellow = (s: string) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s);
const blue = (s: string) => (isTTY ? `\x1b[34m${s}\x1b[0m` : s);

export function printEvent(event: SSEEvent): void {
  // Non-TTY (coding agents): don't write individual events to stdout.
  // Coding agents read all stdout at once when the process exits;
  // printRunOutput writes the one result JSON at the end.
  if (!isTTY || event.event_type === "run_complete") return;
  stdoutSync(dim(`  [${event.event_type}]`) + "\n");
}

function printCallResult(result: Partial<FormattedConversationResult>): void {
  const callName = result.name ?? "call";
  const callStatus = result.status;
  const durationMs = result.duration_ms;

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

/** Print the run result: the API's JSON unchanged for coding agents, a short summary on a terminal. */
export function printRunOutput(output: RunOutput): void {
  if (!isTTY) {
    stdoutSync(JSON.stringify(output, null, 2) + "\n");
    return;
  }

  const calls = (output.calls ?? []) as Array<Partial<FormattedConversationResult>>;
  for (const call of calls) printCallResult(call);

  stdoutSync("\n");
  stdoutSync(bold("Run complete") + dim(" — Vent does not judge mission success; review the calls above.") + "\n");
  stdoutSync(`${calls.length} call${calls.length === 1 ? "" : "s"} ran\n`);
  if (typeof output.error_text === "string") {
    stdoutSync(red(`Run ${String(output.status ?? "ended")}: ${output.error_text}`) + "\n");
  }
  stdoutSync(dim(`Run ID: ${String(output.run_id)}`) + "\n");
}

export function printError(message: string): void {
  const line = red(bold("error")) + ` ${message}\n`;
  stdoutSync(line);
}

/**
 * Run lifecycle messages (run created, stop outcome). Always printed, on stderr,
 * so coding agents see them while stdout stays the one result.
 */
export function printStatus(message: string): void {
  writeSync(2, message + "\n");
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
