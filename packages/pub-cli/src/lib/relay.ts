import { spawn, type ChildProcess } from "node:child_process";
import type { AgentSessionResponse } from "@vent/shared";
import { RelayClient } from "./relay-client.js";

export interface RelayHandle {
  client: RelayClient;
  agentProcess: ChildProcess | null;
  cleanup: () => Promise<void>;
}

/**
 * Start a persistent agent session relay and optionally spawn the agent process.
 */
export async function startAgentSession(relayConfig: AgentSessionResponse): Promise<RelayHandle> {
  const client = new RelayClient({
    apiUrl: relayConfig.api_url,
    sessionId: relayConfig.session_id,
    relayToken: relayConfig.relay_token,
    agentPort: relayConfig.agent_port,
  });

  // 1. Connect relay WebSocket — establishes the tunnel to Vent cloud
  await client.connect();

  // 2. Spawn agent process (with PORT env so it listens on the right port)
  let agentProcess: ChildProcess | null = null;

  if (relayConfig.start_command) {
    const env = { ...process.env, PORT: String(relayConfig.agent_port) };
    agentProcess = spawn(relayConfig.start_command, {
      shell: true,
      stdio: "pipe",
      env,
    });

    // Drain agent output without mixing it into the CLI's JSON response.
    agentProcess.stdout?.resume();
    agentProcess.stderr?.resume();

    agentProcess.on("error", (err) => {
      process.stdout.write(`Agent process error: ${err.message}\n`);
    });

    // 3. Wait for agent to be healthy before exposing the session as ready
    await waitForHealth(relayConfig.agent_port, relayConfig.health_endpoint);
  }

  const cleanup = async () => {
    if (agentProcess && !agentProcess.killed) {
      agentProcess.kill("SIGTERM");
    }
    await client.disconnect();
  };

  return { client, agentProcess, cleanup };
}

async function waitForHealth(port: number, endpoint: string, timeoutMs = 30_000): Promise<void> {
  const url = `http://localhost:${port}${endpoint}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`Agent health check timed out after ${timeoutMs}ms at ${url}`);
}
