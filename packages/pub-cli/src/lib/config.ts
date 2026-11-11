import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { AccessCredentialsSchema, type AccessCredentials } from "@vent/shared";

const CONFIG_DIR = path.join(homedir(), ".vent");
const CREDENTIALS_FILE = path.join(CONFIG_DIR, "credentials");

export const API_BASE = process.env.VENT_API_URL ?? "https://api.venthq.dev";
export const DASHBOARD_URL = process.env.VENT_DASHBOARD_URL ?? "https://venthq.dev";

interface CredentialsSource {
  accessToken?: string;
  refreshToken?: string;
  environment: boolean;
}

const refreshes = new Map<string, Promise<string>>();

async function readCredentials(): Promise<CredentialsSource | null> {
  const accessToken = process.env.VENT_ACCESS_TOKEN;
  const refreshToken = process.env.VENT_REFRESH_TOKEN;
  if (accessToken || refreshToken) return { accessToken, refreshToken, environment: true };
  try {
    const parsed = AccessCredentialsSchema.safeParse(JSON.parse(await fs.readFile(CREDENTIALS_FILE, "utf-8")));
    if (parsed.success) return {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      environment: false,
    };
  } catch {}
  return null;
}

function usableAccessToken(token: string | undefined, marginMs = 0): token is string {
  if (!token) return false;
  try { return (decodeJwt(token).exp ?? 0) * 1_000 > Date.now() + marginMs; }
  catch { return false; }
}

async function refresh(source: CredentialsSource): Promise<string> {
  const refreshToken = source.refreshToken!;
  const existing = refreshes.get(refreshToken);
  if (existing) return existing;
  const work = (async () => {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("Could not refresh Vent sign-in. Check your connection and try again.");
    }
    if (!response.ok) {
      throw new Error(response.status === 401
        ? "Vent credentials were rejected. Run `npx vent-hq login` again or replace VENT_REFRESH_TOKEN."
        : `Vent sign-in refresh failed (${response.status}). Try again.`);
    }
    const parsed = AccessCredentialsSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Vent returned invalid sign-in credentials.");
    const credentials = parsed.data;
    if (source.environment) {
      process.env.VENT_ACCESS_TOKEN = credentials.access_token;
      process.env.VENT_REFRESH_TOKEN = credentials.refresh_token;
    } else {
      await saveCredentials(credentials);
    }
    return credentials.access_token;
  })();
  refreshes.set(refreshToken, work);
  try { return await work; }
  finally { refreshes.delete(refreshToken); }
}

export async function loadAccessToken(): Promise<string | null> {
  const source = await readCredentials();
  if (!source) return null;
  if (source.refreshToken && !usableAccessToken(source.accessToken, 60_000)) return refresh(source);
  return usableAccessToken(source.accessToken) ? source.accessToken : null;
}

export async function refreshAccessToken(rejectedToken: string): Promise<string | null> {
  const source = await readCredentials();
  if (!source?.refreshToken) return null;
  if (source.accessToken !== rejectedToken && usableAccessToken(source.accessToken, 60_000)) {
    return source.accessToken;
  }
  return refresh(source);
}

export async function saveCredentials(credentials: AccessCredentials): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${CREDENTIALS_FILE}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(credentials)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, CREDENTIALS_FILE);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function deleteCredentials(): Promise<void> {
  try {
    await fs.rm(CREDENTIALS_FILE);
  } catch {
    // File doesn't exist, that's fine
  }
}
