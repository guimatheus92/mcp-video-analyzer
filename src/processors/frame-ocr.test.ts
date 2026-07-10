import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isMeaningfulOcr, ocrFrames } from './frame-ocr.js';

const createWorker = vi.hoisted(() =>
  vi.fn(async () => ({
    recognize: async () => ({ data: { text: 'mocked text', confidence: 90 } }),
    terminate: async () => undefined,
  })),
);

vi.mock('tesseract.js', () => ({ createWorker, default: { createWorker } }));

describe('isMeaningfulOcr', () => {
  it('requires text length > 3 AND confidence > 50 (both strict)', () => {
    expect(isMeaningfulOcr({ time: '0:01', text: 'R$ 99', confidence: 88 })).toBe(true);
    // length exactly 3 → rejected
    expect(isMeaningfulOcr({ time: '0:01', text: 'abc', confidence: 90 })).toBe(false);
    // length 4 → accepted (with high confidence)
    expect(isMeaningfulOcr({ time: '0:01', text: 'abcd', confidence: 90 })).toBe(true);
    // confidence exactly 50 → rejected
    expect(isMeaningfulOcr({ time: '0:01', text: 'abcde', confidence: 50 })).toBe(false);
    // confidence 51 → accepted
    expect(isMeaningfulOcr({ time: '0:01', text: 'abcde', confidence: 51 })).toBe(true);
    // empty text → rejected
    expect(isMeaningfulOcr({ time: '0:01', text: '', confidence: 99 })).toBe(false);
  });
});

describe('ocrFrames', () => {
  it('routes traineddata downloads to the tmp cache dir, never the process cwd', async () => {
    const results = await ocrFrames(
      [{ time: '0:00', filePath: join(tmpdir(), 'nonexistent-frame.jpg'), mimeType: 'image/jpeg' }],
      'eng',
    );

    expect(results).toHaveLength(1);
    expect(createWorker).toHaveBeenCalledWith('eng', undefined, {
      cachePath: join(tmpdir(), 'mcp-video-analyzer', 'tessdata'),
    });
  });
});
