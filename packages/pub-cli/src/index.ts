import { parseArgs } from "node:util";
import { runCommand } from "./commands/run.js";
import { agentStartCommand, agentStopCommand } from "./commands/agent.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { initCommand } from "./commands/init.js";
import { stopCommand } from "./commands/stop.js";
import { printError } from "./lib/output.js";
import { loadDotenv } from "./lib/dotenv.js";

const USAGE = `Usage: vent-hq <command> [options]

Commands:
  init         Set up Vent (auth + skill files)
  agent        Manage a shared local agent session
  run          Run a call from a suite file
  stop         Cancel a queued or running call
  login        Authenticate via browser
  logout       Remove saved credentials
Options:
  --help, -h     Show help
  --version, -v  Show version

Run 'npx vent-hq <command> --help' for command-specific help.`;

const INIT_USAGE = `Usage: vent-hq init

Authenticate (GitHub CLI token or browser sign-in), install the Vent skill
files for Claude Code, Cursor, Codex and Windsurf.`;

const RUN_USAGE = `Usage: vent-hq run -f <suite.json> [options]

Options:
  --file, -f     Path to suite JSON file (required)
  --call         Name of the call to run (required if suite has multiple calls)
  --session, -s  Reuse an existing local agent session`;

const AGENT_USAGE = `Usage: vent-hq agent <command> [options]

Commands:
  start         Start a shared local agent session and keep the relay open
  stop          Close a shared local agent session

Start options:
  --config, -c   Config JSON string with a connection block
  --file, -f     Path to config JSON file

Stop options:
  vent-hq agent stop <session-id>`;

const STOP_USAGE = `Usage: vent-hq stop <run-id>

Cancel a queued or running call.`;

const LOGIN_USAGE = `Usage: vent-hq login [options]

Options:
  --status       Check whether you are logged in (exit code 1 if not)`;

const LOGOUT_USAGE = `Usage: vent-hq logout

Remove saved credentials from ~/.vent/credentials.`;

const COMMAND_USAGE: Record<string, string> = {
  init: INIT_USAGE,
  run: RUN_USAGE,
  agent: AGENT_USAGE,
  stop: STOP_USAGE,
  login: LOGIN_USAGE,
  logout: LOGOUT_USAGE,
};

async function main(): Promise<number> {
  loadDotenv();

  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || args.includes("--help") || args.includes("-h")) {
    console.log(COMMAND_USAGE[command ?? ""] ?? USAGE);
    return 0;
  }

  if (command === "--version" || command === "-v") {
    const pkg = await import("../package.json", { with: { type: "json" } });
    console.log(`vent-hq ${pkg.default.version}`);
    return 0;
  }

  // Remove the command name for parseArgs
  const commandArgs = args.slice(1);

  switch (command) {
    case "init": {
      return initCommand();
    }

    case "run": {
      const { values } = parseArgs({
        args: commandArgs,
        options: {
          file: { type: "string", short: "f" },
          call: { type: "string" },
          session: { type: "string", short: "s" },
        },
        strict: true,
      });

      if (!values.file) {
        printError("Missing --file (-f). Provide a suite JSON file.");
        console.log(RUN_USAGE);
        return 2;
      }

      return runCommand({
        file: values.file,
        call: values.call,
        session: values.session,
      });
    }

    case "agent": {
      const subcommand = commandArgs[0];
      if (!subcommand) {
        console.log(AGENT_USAGE);
        return 0;
      }

      if (subcommand === "start") {
        const { values } = parseArgs({
          args: commandArgs.slice(1),
          options: {
            config: { type: "string", short: "c" },
            file: { type: "string", short: "f" },
          },
          strict: true,
        });
        return agentStartCommand({
          config: values.config,
          file: values.file,
        });
      }

      if (subcommand === "stop") {
        const sessionId = commandArgs[1];
        if (!sessionId) {
          console.log(AGENT_USAGE);
          return 2;
        }
        return agentStopCommand({ sessionId });
      }

      printError(`Unknown agent subcommand: ${subcommand}`);
      console.log(AGENT_USAGE);
      return 2;
    }

    case "stop": {
      const runId = commandArgs[0];
      if (!runId) {
        console.log(STOP_USAGE);
        return 2;
      }
      return stopCommand({ runId });
    }

    case "login": {
      const { values } = parseArgs({
        args: commandArgs,
        options: {
          status: { type: "boolean", default: false },
        },
        strict: true,
      });
      return loginCommand({ status: values.status! });
    }

    case "logout": {
      return logoutCommand();
    }

    default:
      printError(`Unknown command: ${command}`);
      console.log(USAGE);
      return 2;
  }
}

main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  printError((err as Error).message);
  process.exitCode = 2;
});
