import { execFileSync } from "node:child_process";

/**
 * Detect a GitHub token from environment or gh CLI.
 * Returns the raw token string, or null if unavailable.
 */
export function detectGitHubToken(): string | null {
  // 1. Explicit env vars (highest priority)
  const envToken = process.env["GH_TOKEN"] || process.env["GITHUB_TOKEN"];
  if (envToken?.trim()) return envToken.trim();

  // 2. Shell out to gh CLI
  try {
    const result = execFileSync("gh", ["auth", "token"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const token = result.trim();
    if (token) return token;
  } catch {
    // gh not installed, not authenticated, or command failed
  }

  return null;
}
