/** Loads .env.local, then .env, from the current folder. Values already set win: shell > .env.local > .env. */
export function loadDotenv(): void {
  for (const file of [".env.local", ".env"]) {
    try { process.loadEnvFile(file); } catch {} // missing file: skip
  }
}
