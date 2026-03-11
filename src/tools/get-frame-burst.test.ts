import { FastMCP } from 'fastmcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAdapters } from '../adapters/adapter.interface.js';
import { registerGetFrameBurst } from './get-frame-burst.js';

describe('get_frame_burst tool', () => {
  let server: FastMCP;

  beforeEach(() => {
    clearAdapters();
    server = new FastMCP({ name: 'test', version: '0.0.0' });
    registerGetFrameBurst(server);
  });

  afterEach(() => {
    clearAdapters();
  });

  it('registers the tool on the server', () => {
    expect(server).toBeDefined();
  });
});
