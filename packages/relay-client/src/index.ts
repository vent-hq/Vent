import { execSync, spawn, type ChildProcess } from "node:child_process";
import { RelayClient } from "./client.js";

// ---------------------------------------------------------------------------
// Arg parsing (no deps)
// ---------------------------------------------------------------------------

function getArg(name: string, fallback?: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1]!;
  const env = process.env[`VENT_${name.toUpperCase().replace(/-/g, "_")}`];
  if (env) return env;
  if (fallback !== undefined) return fallback;
  console.error(`Missing required argument: --${name}`);
  process.exit(1);
}

const sessionId = getArg("session-id");
const token = getArg("token");
const apiUrl = getArg("api-url");
const startCommand = process.argv.includes("--start-command")
  ? getArg("start-command")
  : undefined;
const agentPort = parseInt(getArg("agent-port", "3001"), 10);
const healthEndpoint = getArg("health-endpoint", "/health");

// ---------------------------------------------------------------------------
// Port cleanup — kill any existing process on the agent port
// ---------------------------------------------------------------------------

async function killPort(port: number): Promise<void> {
  try {
    const pids = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: "utf-8" }).trim();
    if (pids) {
      for (const pid of pids.split("\n")) {
        try {
          process.kill(parseInt(pid, 10), "SIGKILL");
        } catch {
          // Process already gone
        }
      }
      console.error(`[relay] Killed existing process(es) on port ${port}`);

      // Wait for the OS to release the port after SIGKILL
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          const check = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: "utf-8" }).trim();
          if (!check) break;
        } catch {
          break; // No process on port — good
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  } catch {
    // lsof not found or no process — fine
  }
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

async function waitForHealth(port: number, path: string, timeoutMs = 60_000): Promise<void> {
  const url = `http://localhost:${port}${path}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }

  throw new Error(`Agent health check timed out after ${timeoutMs / 1000}s at ${url}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let agentProcess: ChildProcess | null = null;

async function main() {
  // 1. Connect the relay tunnel to Vent
  const client = new RelayClient({
    apiUrl,
    sessionId,
    relayToken: token,
    agentPort,
    healthEndpoint,
  });

  console.error("[relay] Connecting to relay server...");
  await client.connect();
  console.error("[relay] Connected to relay server");

  // 2. Start agent if --start-command provided
  if (startCommand) {
    await killPort(agentPort);
    console.error(`[relay] Starting agent: ${startCommand}`);
    agentProcess = spawn(startCommand, {
      shell: true,
      stdio: "pipe",
      env: { ...process.env, PORT: String(agentPort) },
    });

    agentProcess.stdout?.on("data", (data: Buffer) => {
      process.stderr.write(`[agent] ${data}`);
    });
    agentProcess.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[agent] ${data}`);
    });

    agentProcess.on("exit", (code, signal) => {
      console.error(`[relay] Agent process exited (code=${code}, signal=${signal})`);
    });

    // 3. Wait for health
    console.error(`[relay] Waiting for agent health at localhost:${agentPort}${healthEndpoint}...`);
    await waitForHealth(agentPort, healthEndpoint);
    console.error("[relay] Agent is healthy");
  }

  console.error(`[relay] Agent session ${sessionId} ready`);

  // 4. Listen for events
  client.on("disconnected", () => {
    console.error("[relay] Disconnected from relay server");
  });

  client.on("error", (err: unknown) => {
    console.error("[relay] Error:", err instanceof Error ? err.message : err);
  });

  // 5. Handle shutdown
  const shutdown = () => {
    console.error("[relay] Shutting down...");
    client.disconnect();
    if (agentProcess) {
      agentProcess.kill("SIGTERM");
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[relay] Fatal error:", err.message);
  if (agentProcess) agentProcess.kill("SIGTERM");
  process.exit(1);
});
