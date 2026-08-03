/**
 * Interpret an environment-variable string as a boolean flag.
 * True for `1`, `true`, `yes`, `on` (case-insensitive, trimmed); false otherwise
 * (including unset). Use for opt-in features that default to off.
 */
export function envFlag(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * Interpret an environment-variable string as a non-negative integer, falling
 * back when unset, blank or unparsable.
 *
 * Deliberately stricter than `Number()`: only plain digits are accepted, so
 * `1e3` and `0x20` fall back rather than silently becoming 1000 and 32. Any
 * word-shaped aliases belong to the setting that defines them, not here — a
 * generic helper that understood `native` would also accept it for a JPEG
 * quality, where it means nothing.
 */
export function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}
