import { saveCredentials, API_BASE } from "./config.js";
import { AccessCredentialsSchema } from "@vent/shared";
import { openBrowser } from "./browser.js";
import { printError, printInfo } from "./output.js";

const POLL_INTERVAL_MS = 2000;

export type AuthResult =
  | { ok: true; accessToken: string }
  | { ok: false; error: string };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function deviceAuthFlow(): Promise<AuthResult> {
  // 1. Start device session
  let startData: {
    session_id: string;
    user_code: string;
    verification_url: string;
    expires_at: string;
  };

  try {
    const res = await fetch(`${API_BASE}/device/start`, { method: "POST" });
    if (!res.ok) {
      return { ok: false, error: `Failed to start device auth: ${res.status}` };
    }
    startData = (await res.json()) as typeof startData;
  } catch {
    return { ok: false, error: "Could not reach Vent API. Check your connection." };
  }

  // 2. Show code and open browser
  printInfo(`Your authorization code: ${startData.user_code}`, { force: true });
  printInfo(`Opening browser to log in...`, { force: true });
  printInfo(`If the browser doesn't open, visit: ${startData.verification_url}`, { force: true });
  openBrowser(startData.verification_url);

  // 3. Poll for approval
  const deadline = new Date(startData.expires_at).getTime();

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    try {
      const res = await fetch(`${API_BASE}/device/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: startData.session_id }),
      });

      if (!res.ok) continue;

      const data = (await res.json()) as {
        status?: "pending" | "approved" | "expired" | "consumed" | "invalid";
      };

      if (data.status === "approved") {
        const parsed = AccessCredentialsSchema.safeParse(data);
        if (!parsed.success) return { ok: false, error: "Vent returned invalid sign-in credentials." };
        await saveCredentials(parsed.data);
        return { ok: true, accessToken: parsed.data.access_token };
      }

      if (data.status === "expired") {
        return { ok: false, error: "Session expired. Run `npx vent-hq login` again." };
      }

      if (data.status === "consumed" || data.status === "invalid") {
        return { ok: false, error: "Session invalid. Run `npx vent-hq login` again." };
      }

      // status === "pending" — keep polling
    } catch {
      // Network error — keep trying
    }
  }

  return { ok: false, error: "Login timed out. Run `npx vent-hq login` again." };
}
