import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = path.join(homedir(), ".vent");
const CREDENTIALS_FILE = path.join(CONFIG_DIR, "credentials");

export const API_BASE = "https://api.venthq.dev";
export const DASHBOARD_URL = process.env.VENT_DASHBOARD_URL ?? "https://venthq.dev";

export async function loadAccessToken(): Promise<string | null> {
  // 1. Environment variable (highest priority)
  if (process.env.VENT_ACCESS_TOKEN) return process.env.VENT_ACCESS_TOKEN;

  // 2. Credentials file
  try {
    const raw = await fs.readFile(CREDENTIALS_FILE, "utf-8");
    const key = raw.trim();
    if (key) return key;
  } catch {
    // File doesn't exist
  }

  return null;
}

export async function saveAccessToken(token: string): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CREDENTIALS_FILE, token + "\n", { mode: 0o600 });
}

export async function deleteCredentials(): Promise<void> {
  try {
    await fs.rm(CREDENTIALS_FILE);
  } catch {
    // File doesn't exist, that's fine
  }
}

export function validateAccessTokenFormat(token: string): boolean {
  return token.startsWith("vent_") && token.length > 10;
}
