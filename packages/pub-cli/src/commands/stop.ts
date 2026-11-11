import { apiFetch, ApiError } from "../lib/api.js";
import { printError, printSuccess } from "../lib/output.js";

interface StopArgs {
  runId: string;
}

export async function stopCommand(args: StopArgs): Promise<number> {
  try {
    const res = await apiFetch(`/runs/${args.runId}/stop`, {
      method: "POST",
    });
    const data = (await res.json()) as { id: string; status: "cancelled" | "cancelling" };
    printSuccess(
      data.status === "cancelling"
        ? `Run ${data.id} is stopping — the call hangs up at the end of the current turn.`
        : `Run ${data.id} cancelled.`,
      { force: true },
    );
  } catch (err) {
    if (err instanceof ApiError) {
      const body = err.body as { error?: string };
      printError(body?.error ?? `Failed to stop run (${err.status}).`);
      return 1;
    }
    throw err;
  }

  process.exit(0);
}
