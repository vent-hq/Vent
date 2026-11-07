import { execaCommand } from "execa";

const cwd = new URL("../", import.meta.url);
const { stdout } = await execaCommand("docker compose -f compose.local.yaml config --format json", { cwd });
const local = JSON.parse(stdout)["x-local-environment"];
const database = new URL(local.DATABASE_URL);
if (database.hostname !== "127.0.0.1" || database.pathname !== "/vent_local") {
  throw new Error("Local development requires the local vent_local database.");
}
const run = (command) => execaCommand(command, { cwd, env: local, stdio: "inherit" });

await run("docker compose -f compose.local.yaml up -d --wait --remove-orphans");
await run("pnpm db:migrate");
await run("pnpm --filter @vent/db seed:local");
await run("pnpm --filter @vent/relay-client build");
await run("pnpm --parallel --filter @vent/api --filter @vent/worker dev");
