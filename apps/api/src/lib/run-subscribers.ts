import IORedis from "ioredis";
import { EventEmitter } from "node:events";
import { requireEnv } from "@vent/shared";

/**
 * Redis pub/sub for broadcasting run events across API instances.
 *
 * Uses a SINGLE shared subscriber connection that fans out to per-run
 * listeners via a local EventEmitter. The previous implementation opened
 * one IORedis.duplicate() per SSE client, which exhausted Upstash
 * connection limits under sustained dashboard load. We subscribe to
 * `vent:run-events:*` once via psubscribe and dispatch by run_id locally.
 */

const redisUrl = requireEnv("REDIS_URL");

const redisPub = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const redisSub = new IORedis(redisUrl, { maxRetriesPerRequest: null });

const CHANNEL_PREFIX = "vent:run-events:";
const PATTERN = `${CHANNEL_PREFIX}*`;

const localBus = new EventEmitter();
// SSE clients can pile up — Node's default 10-listener warning is just noise here.
localBus.setMaxListeners(0);

// Attach the pmessage handler BEFORE psubscribe so we don't lose any messages
// emitted in the tiny window between Redis acking SUBSCRIBE and the .then()
// callback running. IORedis emits pmessage events to all attached listeners;
// attaching first guarantees we receive every message from the moment the
// subscription is active.
redisSub.on("pmessage", (_pattern: string, channel: string, message: string) => {
  const runId = channel.slice(CHANNEL_PREFIX.length);
  localBus.emit(runId, message);
});

let psubscribed: Promise<void> | null = null;
function ensurePsubscribed(): Promise<void> {
  if (psubscribed) return psubscribed;
  psubscribed = redisSub.psubscribe(PATTERN).then(() => {});
  return psubscribed;
}

export interface RunEventPayload {
  id?: string;
  run_id: string;
  event_type: string;
  message: string;
  metadata_json?: Record<string, unknown> | null;
  created_at?: string;
}

/**
 * Publish event to ALL API instances via Redis pub/sub.
 */
export function broadcast(runId: string, event: RunEventPayload): void {
  const channel = `${CHANNEL_PREFIX}${runId}`;
  void redisPub.publish(channel, JSON.stringify(event));
}

/**
 * Subscribe to events for a specific run_id. Returns an unsubscribe function.
 * Cheap (just adds an EventEmitter listener) and shares the single Redis
 * psubscribe connection across all SSE clients on this API instance.
 */
export async function subscribeToRun(
  runId: string,
  handler: (rawMessage: string) => void,
): Promise<() => void> {
  await ensurePsubscribed();
  localBus.on(runId, handler);
  return () => {
    localBus.off(runId, handler);
  };
}

/**
 * Clean up Redis connections on server shutdown.
 */
export async function shutdownSubscribers(): Promise<void> {
  redisPub.disconnect();
  redisSub.disconnect();
  localBus.removeAllListeners();
}
