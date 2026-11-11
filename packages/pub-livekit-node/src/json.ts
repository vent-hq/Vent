/** Turning LiveKit SDK objects into plain JSON values. */

/** Makes SDK objects JSON-safe. Objects nested deeper than 8 levels, and
 *  references back to an enclosing object (cycles), become null. */
export function toJsonable(value: unknown, depth = 0, ancestors: object[] = []): unknown {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return compact({ name: value.name, message: value.message, stack: value.stack });
  if (depth > 8 || ancestors.includes(value)) return null;
  const inner = [...ancestors, value];
  const nested = (v: unknown) => toJsonable(v, depth + 1, inner);
  if (Array.isArray(value)) return value.map(nested);
  if (value instanceof Map) {
    return Object.fromEntries(Array.from(value.entries()).map(([k, v]) => [String(k), nested(v)]));
  }
  if (value instanceof Set) return Array.from(value.values()).map(nested);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => typeof v !== "function" && typeof v !== "symbol")
      .map(([k, v]) => [k, nested(v)]),
  );
}

/** The own fields of an SDK object, one level deep; {} for anything else. */
export function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};
}

/** One field of an SDK object; undefined when it's missing. */
export function field(value: unknown, name: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined;
}

export function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v != null));
}
