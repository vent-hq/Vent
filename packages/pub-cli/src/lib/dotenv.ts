import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Load .env files into process.env (never overrides existing vars).
 * Precedence: shell env > .env.local > .env
 */
export function loadDotenv(dir: string = process.cwd()): void {
  // .env.local first (higher priority), then .env
  for (const file of [".env.local", ".env"]) {
    try {
      const content = readFileSync(resolve(dir, file), "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        // Never override existing env vars
        if (process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    } catch {
      // File doesn't exist — skip silently
    }
  }
}
