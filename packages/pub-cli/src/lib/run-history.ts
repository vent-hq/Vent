import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { RunOutput } from "@vent/shared";

interface RunHistoryEntry {
  run_id: string;
  timestamp: string;
  git_sha: string | null;
  summary: {
    status: string;
    calls_total: number;
    total_duration_ms?: number;
  };
  call_results: RunOutput["calls"];
}

function gitSha(): string | null {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

export async function saveRunHistory(output: RunOutput): Promise<string | null> {
  try {
    const runId = output.run_id;
    const dir = path.join(process.cwd(), ".vent", "runs");
    await fs.mkdir(dir, { recursive: true });

    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const shortId = runId.slice(0, 8);

    const calls = output.calls;

    const entry: RunHistoryEntry = {
      run_id: runId,
      timestamp: now.toISOString(),
      git_sha: gitSha(),
      summary: {
        status: output.status,
        calls_total: calls.length,
        total_duration_ms: calls.reduce((sum, c) => sum + (c.duration_ms ?? 0), 0),
      },
      call_results: calls,
    };

    const filename = `${timestamp}_${shortId}.json`;
    const filepath = path.join(dir, filename);
    await fs.writeFile(filepath, JSON.stringify(entry, null, 2) + "\n");

    return filepath;
  } catch {
    return null;
  }
}
