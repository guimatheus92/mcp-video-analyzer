#!/usr/bin/env node

import { VERSION } from './version.js';

const USAGE = `mcp-video-analyzer ${VERSION}

Usage:
  mcp-video-analyzer                          Start the MCP server (stdio)
  mcp-video-analyzer analyze <url> [options]  One-shot analysis: JSON on stdout
  mcp-video-analyzer analyze --help           Show analyze options
`;

const cmd = process.argv[2];

if (cmd === 'analyze') {
  const { runCli } = await import('./cli.js');
  process.exitCode = await runCli(process.argv.slice(3));
} else if (cmd === '--version' || cmd === '-v') {
  process.stdout.write(`${VERSION}\n`);
} else if (cmd === '--help' || cmd === '-h') {
  process.stdout.write(USAGE);
} else if (cmd === undefined) {
  const { createServer } = await import('./server.js');
  createServer().start({ transportType: 'stdio' });
} else {
  process.stderr.write(`Unknown command "${cmd}".\n\n${USAGE}`);
  process.exitCode = 1;
}
