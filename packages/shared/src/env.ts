export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/** Reads a positive integer env var. Without a fallback the variable is
 *  required; a set but invalid value always throws. */
export function envPositiveInt(name: string, fallback?: number): number {
  const raw = process.env[name];
  if (!raw) {
    if (fallback === undefined) throw new Error(`${name} is required`);
    return fallback;
  }
  const value = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
