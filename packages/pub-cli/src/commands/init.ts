import { loadAccessToken, saveCredentials, API_BASE } from "../lib/config.js";
import { AccessCredentialsSchema } from "@vent/shared";
import { detectGitHubToken } from "../lib/github.js";
import { deviceAuthFlow } from "../lib/auth.js";
import { printError, printInfo, printSuccess } from "../lib/output.js";
import { installSkills } from "../lib/setup.js";

export async function initCommand(): Promise<number> {
  const cwd = process.cwd();

  // 1. Check/save access token
  const token = await loadAccessToken();

  if (token) {
    printSuccess("Authenticated.", { force: true });
  } else {
    // Two paths to a token, in order of frictionlessness:
    //  1. GitHub CLI token (via `gh auth token` or env) — silent.
    //  2. Browser device-auth via WorkOS — one-time interactive sign-in.
    // The legacy anonymous bootstrap path was removed; every account is
    // now backed by a verified identity.
    let authenticated = false;
    const ghToken = detectGitHubToken();

    if (ghToken) {
      try {
        const res = await fetch(`${API_BASE}/auth/github`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ github_token: ghToken }),
        });

        if (res.ok) {
          const data = await res.json() as { username: string };
          const credentials = AccessCredentialsSchema.parse(data);
          const username = data.username;
          await saveCredentials(credentials);
          printSuccess(`Authenticated as @${username} (via GitHub).`, {
            force: true,
          });
          authenticated = true;
        }
      } catch {
        // GitHub verification failed — fall through to browser sign-in
      }
    }

    if (!authenticated) {
      printInfo(
        "No GitHub token detected. Opening browser to sign in...",
        { force: true },
      );
      const result = await deviceAuthFlow();
      if (!result.ok) {
        printError(`Sign-in failed: ${result.error}`);
        return 1;
      }
      printSuccess("Authenticated.", { force: true });
    }
  }

  // 2. Install skill files
  await installSkills(cwd);

  printSuccess(
    "Ready — your coding agent can now run calls with `npx vent-hq run`.",
    { force: true },
  );
  return 0;
}
