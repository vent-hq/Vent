import { stopRun } from "../lib/stop-run.js";
import { printError, printSuccess } from "../lib/output.js";

interface StopArgs {
  runId: string;
}

export async function stopCommand(args: StopArgs): Promise<number> {
  const { ok, message } = await stopRun(args.runId);
  if (!ok) {
    printError(message);
    return 1;
  }
  printSuccess(message, { force: true });
  process.exit(0);
}
