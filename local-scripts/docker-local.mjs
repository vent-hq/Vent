import { createHash } from "node:crypto";
import { execa, execaCommand } from "execa";

// Runs Vent's API and worker in Docker. The CLI supplies the deployed agent's platform configuration.
const cwd = new URL("../", import.meta.url);
for (const key of ["DEEPGRAM_API_KEY", "ANTHROPIC_API_KEY", "JWT_PRIVATE_KEY"]) {
  if (!process.env[key]) throw new Error(`Missing ${key}; run with doppler run --project vent --config dev -- pnpm dev:docker.`);
}
const { stdout } = await execaCommand("docker compose -f compose.local.yaml config --format json", { cwd });
const local = JSON.parse(stdout)["x-local-environment"];
if (new URL(local.DATABASE_URL).hostname !== "127.0.0.1" || new URL(local.DATABASE_URL).pathname !== "/vent_local") {
  throw new Error("Local Docker testing requires the isolated vent_local database.");
}
const run = (command, env = {}) => execaCommand(command, { cwd, env: { ...local, ...env }, stdio: "inherit" });
await run("docker compose -f compose.local.yaml up -d --wait postgres redis storage");
await run("pnpm db:migrate");
const tokenHash = createHash("sha256").update(local.VENT_REFRESH_TOKEN).digest("hex");
await execa("docker", ["compose", "-f", "compose.local.yaml", "exec", "-T", "postgres", "psql", "-q", "-U", "vent", "-d", "vent_local", "-c",
  `INSERT INTO access_tokens (user_id, token_hash, name) VALUES ('local-developer', '${tokenHash}', 'Local development') ON CONFLICT (token_hash) DO UPDATE SET revoked_at = NULL`,
], { cwd, stdio: "inherit" });
await run("docker compose -f compose.local.yaml --profile app up -d --build --wait");
await run("pnpm --filter vent-hq build");
console.log(`Local Vent stack ready. To call your deployed agent:\ndoppler run --project vent --config dev -- env VENT_API_URL=${local.API_URL} VENT_REFRESH_TOKEN=${local.VENT_REFRESH_TOKEN} node packages/pub-cli/dist/index.mjs run -f <suite.json>\nSee local-scripts/README.md for platform configuration.`);
