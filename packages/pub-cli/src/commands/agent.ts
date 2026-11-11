import * as fs from "node:fs/promises";
import * as net from "node:net";
import { AgentSessionResponseSchema, type AgentSessionResponse } from "@vent/shared";
import { apiFetch } from "../lib/api.js";
import { printError, printInfo, printSuccess } from "../lib/output.js";
import { startAgentSession, type RelayHandle } from "../lib/relay.js";
import type { RelayDisconnectedInfo } from "../lib/relay-client.js";

interface AgentStartArgs {
  config?: string;
  file?: string;
}

interface AgentStopArgs {
  sessionId: string;
}

export async function agentStartCommand(args: AgentStartArgs): Promise<number> {
  let parsedConfig: unknown;
  try {
    if (args.file) {
      parsedConfig = JSON.parse(await fs.readFile(args.file, "utf-8"));
    } else if (args.config) {
      parsedConfig = JSON.parse(args.config);
    } else {
      printError("Provide --config '{...}' or -f <file>.");
      return 2;
    }
  } catch (err) {
    printError(`Invalid config JSON: ${(err as Error).message}`);
    return 2;
  }

  const root = parsedConfig as {
    connection?: {
      adapter?: string;
      start_command?: string;
      health_endpoint?: string;
      agent_port?: number;
    };
  };
  const connection = root.connection;
  if (!connection) {
    printError("Agent sessions require a `connection` object in the config.");
    return 2;
  }

  if (!connection.agent_port) {
    connection.agent_port = await findFreePort();
  }

  let session: AgentSessionResponse | null = null;
  let relay: RelayHandle | null = null;

  const closeSession = async () => {
    if (!session) return;
    try {
      await apiFetch(`/agent-sessions/${session.session_id}/close`, {
        method: "POST",
      });
    } catch {
      // Best-effort session cleanup.
    }
  };

  try {
    printInfo("Creating agent session…");
    const createRes = await apiFetch("/agent-sessions", {
      method: "POST",
      body: JSON.stringify({ config: connection }),
    });
    session = AgentSessionResponseSchema.parse(await createRes.json());

    printInfo("Connecting relay for local agent…");
    relay = await startAgentSession(session);

    const sessionData = {
      session_id: session.session_id,
      agent_port: session.agent_port,
      run_example: `npx vent-hq run -f <suite.json> --session ${session.session_id}`,
    };

    process.stdout.write(JSON.stringify(sessionData) + "\n");
    printSuccess(`Agent session ready: ${session.session_id}`, { force: true });
    printInfo(`Run calls with --session ${session.session_id}`, { force: true });

    const exitCode = await waitForSessionExit(relay);
    await relay.cleanup();
    await closeSession();
    return exitCode;
  } catch (err) {
    if (relay) {
      await relay.cleanup().catch(() => {});
    }
    await closeSession();
    printError(`Agent session failed: ${(err as Error).message}`);
    return 2;
  }
}

export async function agentStopCommand(args: AgentStopArgs): Promise<number> {
  try {
    await apiFetch(`/agent-sessions/${args.sessionId}/close`, {
      method: "POST",
    });
    printSuccess(`Agent session closed: ${args.sessionId}`, { force: true });
    return 0;
  } catch (err) {
    printError((err as Error).message);
    return 2;
  }
}

async function waitForSessionExit(relay: RelayHandle): Promise<number> {
  return new Promise<number>((resolve) => {
    let settled = false;
    const agentProcess = relay.agentProcess;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
      if (agentProcess) {
        agentProcess.off("exit", handleAgentExit);
      }
      resolve(code);
    };

    const handleSignal = () => finish(0);
    const handleAgentExit = (code: number | null, signal: NodeJS.Signals | null) => {
      printError(`Agent process exited (code=${code}, signal=${signal})`);
      finish(1);
    };

    relay.client.on("disconnected", (info: unknown) => {
      const disconnect = info as RelayDisconnectedInfo | undefined;
      const isIntentionalClose =
        disconnect?.code === 1000 &&
        disconnect?.reason === "session_closed";

      if (isIntentionalClose) {
        finish(0);
        return;
      }

      printError(
        disconnect
          ? `Relay disconnected unexpectedly (code=${disconnect.code}, reason=${disconnect.reason || "none"})`
          : "Relay disconnected unexpectedly",
      );
      finish(1);
    });
    relay.client.on("error", (err: unknown) => {
      printError(`Relay error: ${err instanceof Error ? err.message : String(err)}`);
      finish(1);
    });
    agentProcess?.on("exit", handleAgentExit);

    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
  });
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const addr = server.address();
      const port = (addr as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}
