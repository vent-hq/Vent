/**
 * Vent's own event protocol: the `vent:*` JSON events that custom WebSocket
 * agents send as text frames and the LiveKit helpers publish as data packets.
 */

import { CallTransferSchema, type CallMetadata, type CallTransfer, type ObservedToolCall } from "@vent/shared";
import {
  asNumber,
  asRecord,
  asString,
  compactNumberRecord,
  compactProviderWarning,
  compactStringRecord,
  compactUnknownRecord,
  dedupeProviderWarnings,
  normalizeProviderWarnings,
} from "./record-utils.js";

export const VENT_EVENTS = {
  toolCalls: "vent:tool-calls",
  callMetadata: "vent:call-metadata",
  session: "vent:session",
  transfer: "vent:transfer",
  debugUrl: "vent:debug-url",
  warning: "vent:warning",
  timing: "vent:timing",
  transcript: "vent:transcript",
  metrics: "vent:metrics",
  conversationItem: "vent:conversation-item",
} as const;

export interface VentToolCallEvent {
  type: "tool_call";
  name: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  successful?: boolean;
  provider_tool_type?: string;
  duration_ms?: number;
  /** Lifecycle marker (WebSocket agents). true = tool call started (suspends
   *  VAD end-of-turn), false = completed. Unset = a completed tool call. */
  in_progress?: boolean;
  /** Stable id for matching start/end frames. */
  tool_call_id?: string;
}

interface VentTransferEvent {
  destination?: string;
  status?: CallTransfer["status"];
  transfer_type?: string;
  timestamp_ms?: number;
  source?: CallTransfer["sources"][number];
}

export function observedToolCall(event: VentToolCallEvent, timestampMs: number): ObservedToolCall {
  return {
    name: event.name,
    arguments: event.arguments ?? {},
    result: event.result,
    successful: event.successful,
    provider_tool_type: event.provider_tool_type,
    timestamp_ms: timestampMs,
    latency_ms: event.duration_ms,
  };
}

/** Call metadata carried by a `vent:call-metadata`, `vent:transfer`, `vent:debug-url` or `vent:warning` event. */
export function ventEventMetadata(
  type: string,
  event: Record<string, unknown>,
  platform: string,
): Partial<CallMetadata> | undefined {
  switch (type) {
    case VENT_EVENTS.callMetadata:
      return normalizeCallMetadata(asRecord(event["call_metadata"]) ?? {}, platform);
    case VENT_EVENTS.transfer: {
      const transferEvent = event as VentTransferEvent;
      return {
        transfers: [{
          type: transferEvent.transfer_type ?? "transfer",
          destination: transferEvent.destination,
          status: transferEvent.status ?? "unknown",
          sources: [transferEvent.source ?? "platform_event"],
          timestamp_ms: transferEvent.timestamp_ms,
        }],
      };
    }
    case VENT_EVENTS.debugUrl: {
      const label = event["label"];
      const url = event["url"];
      if (typeof label !== "string" || !label || typeof url !== "string" || !url) return undefined;
      return { provider_debug_urls: { [label]: url } };
    }
    case VENT_EVENTS.warning: {
      const warning = compactProviderWarning({
        message: typeof event["message"] === "string" ? event["message"] : undefined,
        code: typeof event["code"] === "string" ? event["code"] : undefined,
        detail: event["detail"],
      });
      return warning ? { provider_warnings: [warning] } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Reads an agent-reported call metadata payload, keyed by the `CallMetadata` field
 * names; `platform` is used when it names none. Values of the wrong type are dropped.
 */
export function normalizeCallMetadata(payload: Record<string, unknown>, platform: string): Partial<CallMetadata> {
  return compactUnknownRecord({
    platform: asString(payload["platform"]) ?? platform,
    provider_call_id: asString(payload["provider_call_id"]),
    provider_session_id: asString(payload["provider_session_id"]),
    ended_reason: asString(payload["ended_reason"]),
    cost: normalizeCost(payload["cost"]),
    recording_url: asString(payload["recording_url"]),
    recording_variants: compactStringRecord(asRecord(payload["recording_variants"])),
    provider_debug_urls: compactStringRecord(asRecord(payload["provider_debug_urls"])),
    provider_warnings: normalizeProviderWarnings(payload["provider_warnings"]),
    transfers: normalizeTransfers(payload["transfers"]),
  }) as Partial<CallMetadata>;
}

/** Reads agent-reported transfers, dropping any that don't match the result schema. */
function normalizeTransfers(value: unknown): CallTransfer[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const transfers = value.flatMap((item) => {
    const parsed = CallTransferSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
  return transfers.length > 0 ? transfers : undefined;
}

/** Reads an agent-reported `{ total_usd, breakdown? }` cost; breakdown values must be numbers. */
function normalizeCost(value: unknown): CallMetadata["cost"] {
  const record = asRecord(value);
  const total = asNumber(record?.["total_usd"]);
  if (total == null) return undefined;
  const breakdown = compactNumberRecord(asRecord(record?.["breakdown"]) ?? {});
  return { total_usd: total, ...(breakdown ? { breakdown } : {}) };
}

/** Folds newly reported metadata into what the call has so far. */
export function mergeCallMetadata(current: CallMetadata, incoming: Partial<CallMetadata>): CallMetadata {
  return {
    ...current,
    ...incoming,
    platform: incoming.platform || current.platform,
    recording_variants: { ...current.recording_variants, ...incoming.recording_variants },
    provider_debug_urls: { ...current.provider_debug_urls, ...incoming.provider_debug_urls },
    provider_warnings: dedupeProviderWarnings([...(current.provider_warnings ?? []), ...(incoming.provider_warnings ?? [])]),
    transfers: mergeTransfers([...(current.transfers ?? []), ...(incoming.transfers ?? [])]),
  };
}

/** One entry per distinct transfer, combining the sources that reported it. */
function mergeTransfers(transfers: CallTransfer[]): CallTransfer[] | undefined {
  const merged = new Map<string, CallTransfer>();
  for (const transfer of transfers) {
    const key = JSON.stringify({
      type: transfer.type,
      destination: transfer.destination,
      status: transfer.status,
      timestamp_ms: transfer.timestamp_ms,
    });
    const prior = merged.get(key);
    merged.set(key, prior
      ? {
          ...prior,
          sources: [...new Set([...prior.sources, ...transfer.sources])],
          timestamp_ms: prior.timestamp_ms ?? transfer.timestamp_ms,
        }
      : { ...transfer, sources: [...new Set(transfer.sources)] });
  }
  return merged.size > 0 ? [...merged.values()] : undefined;
}
