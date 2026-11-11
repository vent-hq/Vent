import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { SSEEvent } from "./sse.js";

interface RunHistoryEntry {
  run_id: string;
  timestamp: string;
  git_sha: string | null;
  summary: {
    status: string;
    calls_total: number;
    calls_passed: number;
    calls_failed: number;
    total_duration_ms?: number;
    total_cost_usd?: number;
  };
  call_results: Array<Record<string, unknown>>;
}

function gitSha(): string | null {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

export async function saveRunHistory(
  runId: string,
  callResults: SSEEvent[],
  runCompleteData: Record<string, unknown>,
): Promise<string | null> {
  try {
    const dir = path.join(process.cwd(), ".vent", "runs");
    await fs.mkdir(dir, { recursive: true });

    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const shortId = runId.slice(0, 8);

    const aggregate = runCompleteData.aggregate as Record<string, unknown> | undefined;
    const convCalls = aggregate?.conversation_calls as { total?: number; passed?: number; failed?: number } | undefined;

    const total = convCalls?.total ?? 0;
    const passed = convCalls?.passed ?? 0;
    const failed = convCalls?.failed ?? 0;

    const entry: RunHistoryEntry = {
      run_id: runId,
      timestamp: now.toISOString(),
      git_sha: gitSha(),
      summary: {
        status: runCompleteData.status as string ?? "unknown",
        calls_total: total,
        calls_passed: passed,
        calls_failed: failed,
        total_duration_ms: aggregate?.total_duration_ms as number | undefined,
        total_cost_usd: aggregate?.total_cost_usd as number | undefined,
      },
      call_results: callResults.map((e) => {
        const meta = (e.metadata_json ?? {}) as Record<string, unknown>;
        const result = (meta.result ?? {}) as Record<string, unknown>;
        return { ...result, status: meta.status };
      }),
    };

    const filename = `${timestamp}_${shortId}.json`;
    const filepath = path.join(dir, filename);
    await fs.writeFile(filepath, JSON.stringify(entry, null, 2) + "\n");

    return filepath;
  } catch {
    return null;
  }
}
