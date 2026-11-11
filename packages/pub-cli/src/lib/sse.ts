import type { RunOutput } from "@vent/shared";
import { authenticatedFetch } from "./api.js";

export interface SSEEvent {
  id?: string;
  run_id?: string;
  event_type: string;
  message?: string;
  metadata_json?: Record<string, unknown> | null;
  created_at?: string;
  /** On run_complete: the run result, exactly as the coding agent receives it. */
  result?: RunOutput;
}

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

/**
 * Async generator over SSE events from GET /runs/:id/stream.
 * Yields parsed event objects. Completes when the connection closes
 * or a run_complete event is received.
 *
 * Automatically reconnects if the stream drops before run_complete,
 * deduplicating events by ID so callers never see duplicates.
 */
export async function* streamRunEvents(runId: string, signal?: AbortSignal): AsyncGenerator<SSEEvent> {
  const path = `/runs/${runId}/stream`;
  const seenIds = new Set<string>();
  let retries = 0;

  while (retries <= MAX_RETRIES) {
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }

    let res: Response;
    try {
      res = await authenticatedFetch(path, { signal });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      retries++;
      continue;
    }

    // 502-504: the API machine is restarting (deploy); another one will answer.
    if (res.status >= 502 && res.status <= 504) {
      retries++;
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`SSE stream failed (${res.status}): ${body}`);
    }

    if (!res.body) {
      throw new Error("SSE stream returned no body");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        let readResult: { done: boolean; value?: Uint8Array };
        try {
          readResult = await reader.read();
        } catch (err) {
          if ((err as Error).name === "AbortError") throw err;
          break;
        }

        const { done, value } = readResult;
        if (done) {
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        const lines = buffer.split("\n");
        buffer = lines.pop()!; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const raw = line.slice(6);
            try {
              const event = JSON.parse(raw) as SSEEvent;

              // Deduplicate on reconnect — server replays all events from DB
              if (event.id && seenIds.has(event.id)) {
                continue;
              }
              if (event.id) seenIds.add(event.id);

              yield event;

              if (event.event_type === "run_complete") {
                return;
              }
            } catch {
              // Ignore malformed events.
            }
          }
          // Ignore heartbeat comments and empty lines.
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Stream ended without run_complete — retry
    retries++;
  }

  // Exhausted retries without run_complete — yield a synthetic error event
  // so callers know the stream failed rather than silently getting nothing
  yield {
    event_type: "error",
    message: `Stream lost after ${MAX_RETRIES} reconnect attempts without receiving run_complete`,
  } as SSEEvent;
}
