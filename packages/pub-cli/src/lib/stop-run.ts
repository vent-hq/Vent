import { apiFetch, ApiError } from "./api.js";

/** Asks the API to stop a run and says what happened, in a line ready to print. */
export async function stopRun(
  runId: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await apiFetch(`/runs/${runId}/stop`, { method: "POST", signal });
    const data = (await res.json()) as { status: "cancelled" | "cancelling" };
    return {
      ok: true,
      message: data.status === "cancelling"
        ? `Run ${runId} is stopping — the call hangs up at the end of the current turn.`
        : `Run ${runId} cancelled.`,
    };
  } catch (err) {
    // The API explains why there's nothing to stop ("Run already cancelled", "Run not found").
    if (err instanceof ApiError) {
      const body = err.body as { error?: string };
      return { ok: false, message: body?.error ?? `Stop failed for run ${runId}: HTTP ${err.status}` };
    }
    return { ok: false, message: `Stop failed for run ${runId}: ${(err as Error).message}` };
  }
}
