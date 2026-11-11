/**
 * Shared post-call polling. Platforms finish a call's data (tool calls,
 * latency, cost, recording) a few seconds after it ends — measured on
 * 2026-11-08: Retell ~1s, Vapi ~4-5s. Checking every second returns the data
 * about a second after it is ready, on every platform.
 */
const POLL_INTERVAL_MS = 1_000;
const POLL_ATTEMPTS = 15;

/**
 * Calls `fetchOnce` every second until `isReady` accepts the result, for up to
 * 15s. Returns null if it never became ready (fetch errors count as not ready).
 */
export async function pollUntilReady<T>(
  label: string,
  fetchOnce: () => Promise<T | null>,
  isReady: (value: T) => boolean,
): Promise<T | null> {
  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    try {
      const value = await fetchOnce();
      if (value !== null && isReady(value)) {
        console.log(`    [${label}] ready after ${attempt} attempt(s)`);
        return value;
      }
    } catch (error) {
      console.log(`    [${label}] attempt ${attempt}/${POLL_ATTEMPTS}: ${(error as Error).message}`);
    }
  }
  console.log(`    [${label}] not ready after ${POLL_ATTEMPTS} attempts`);
  return null;
}

/** Reported in a result when the platform's post-call data could not be fetched. */
export function callDataUnavailableWarning(platform: string) {
  return {
    code: "call_data_unavailable",
    message: `Vent could not fetch ${platform}'s call data after the call, so tool calls, latency, cost and the recording are missing from this result.`,
  };
}
