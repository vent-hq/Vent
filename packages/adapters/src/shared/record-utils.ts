/**
 * Helpers for reading loosely typed provider payloads into Vent's result shapes.
 */

import type { ProviderWarning } from "@vent/shared";

/** Drops null/undefined values; undefined when nothing is left. */
export function compactUnknownRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value != null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Keeps only non-empty string values; undefined when nothing is left. */
export function compactStringRecord(record: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!record) return undefined;
  const compacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.length > 0) {
      compacted[key] = value;
    }
  }
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

/** Keeps only finite number values; undefined when nothing is left. */
export function compactNumberRecord(record: Record<string, unknown>): Record<string, number> | undefined {
  const compacted: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "number" && Number.isFinite(value)) compacted[key] = value;
  }
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function compactProviderWarning(warning: ProviderWarning): ProviderWarning | undefined {
  return compactUnknownRecord({ ...warning }) as ProviderWarning | undefined;
}

/** Reads an array of `{ message, code, detail }` warnings. */
export function normalizeProviderWarnings(value: unknown): ProviderWarning[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const warnings: ProviderWarning[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const warning = record && compactProviderWarning({
      message: asString(record["message"]),
      code: asString(record["code"]),
      detail: record["detail"],
    });
    if (warning) warnings.push(warning);
  }
  return warnings.length > 0 ? warnings : undefined;
}

/** Drops empty and repeated warnings; undefined when none are left. */
export function dedupeProviderWarnings(warnings: ProviderWarning[]): ProviderWarning[] | undefined {
  const unique = new Map<string, ProviderWarning>();
  for (const warning of warnings) {
    const compacted = compactProviderWarning(warning);
    if (!compacted) continue;
    const fingerprint = JSON.stringify({ message: compacted.message, code: compacted.code, detail: compacted.detail });
    unique.set(fingerprint, compacted);
  }
  return unique.size > 0 ? [...unique.values()] : undefined;
}
