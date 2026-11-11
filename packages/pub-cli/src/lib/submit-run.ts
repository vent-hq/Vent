import { randomUUID } from "node:crypto";
import { apiFetch, ApiError } from "./api.js";

const RETRY_DELAY_MS = 2_000;

/**
 * Submits a run. If the request fails in a way where the API may have created
 * the run anyway (the connection dropped, or an API machine was restarting),
 * it is sent once more. Both attempts carry the same idempotency key, so if
 * the first one did create the run, the API returns that run instead of
 * starting a second call.
 */
export async function submitRun(payload: Record<string, unknown>): Promise<Response> {
  const body = JSON.stringify({ ...payload, idempotency_key: randomUUID() });
  const send = () => apiFetch("/runs/submit", { method: "POST", body });

  try {
    return await send();
  } catch (err) {
    const answerMayBeLost = !(err instanceof ApiError) || [502, 503, 504].includes(err.status);
    if (!answerMayBeLost) throw err;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return send();
  }
}
