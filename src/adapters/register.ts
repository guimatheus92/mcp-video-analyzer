import { registerAdapter } from './adapter.interface.js';
import { DirectAdapter } from './direct.adapter.js';
import { LocalFileAdapter } from './local-file.adapter.js';
import { LoomAdapter } from './loom.adapter.js';
import { TwelveLabsAdapter } from './twelvelabs.adapter.js';
import { YtDlpAdapter } from './ytdlp.adapter.js';

/**
 * Register the platform adapters (order matters: more specific first).
 * Shared wiring for both entry points — the MCP server (`server.ts`) and the
 * one-shot CLI (`cli.ts`) — so neither depends on the other.
 *
 * TwelveLabsAdapter precedes DirectAdapter: when TWELVELABS_API_KEY is set it
 * takes over direct video URLs (Pegasus transcript + AI summary); otherwise
 * it declines and DirectAdapter handles them as before.
 */
export function registerAllAdapters(): void {
  registerAdapter(new LoomAdapter());
  registerAdapter(new LocalFileAdapter());
  registerAdapter(new YtDlpAdapter());
  registerAdapter(new TwelveLabsAdapter());
  registerAdapter(new DirectAdapter());
}
