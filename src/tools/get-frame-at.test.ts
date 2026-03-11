import { FastMCP } from 'fastmcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAdapters } from '../adapters/adapter.interface.js';
import { registerGetFrameAt } from './get-frame-at.js';

describe('get_frame_at tool', () => {
  let server: FastMCP;

  beforeEach(() => {
    clearAdapters();
    server = new FastMCP({ name: 'test', version: '0.0.0' });
    registerGetFrameAt(server);
  });

  afterEach(() => {
    clearAdapters();
  });

  it('registers the tool on the server', () => {
    expect(server).toBeDefined();
  });
});
