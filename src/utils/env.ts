/**
 * Interpret an environment-variable string as a boolean flag.
 * True for `1`, `true`, `yes`, `on` (case-insensitive, trimmed); false otherwise
 * (including unset). Use for opt-in features that default to off.
 */
export function envFlag(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}
