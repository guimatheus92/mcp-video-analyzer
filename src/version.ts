/**
 * Single source of truth for the runtime version string. Must match
 * package.json (and .claude-plugin/plugin.json) — see the release checklist
 * in CLAUDE.md. `as const` preserves the `${number}.${number}.${number}`
 * literal type FastMCP's `version` field requires.
 */
export const VERSION = '0.7.1' as const;
