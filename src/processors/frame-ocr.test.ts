import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { persistentCacheDir } from '../utils/temp-files.js';
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
  it('routes traineddata downloads to the per-user cache dir, never the process cwd', async () => {
    const results = await ocrFrames(
      [
        {
          time: '0:00',
          filePath: join(
            tmpdir(),
            'nonexistent-frame.jpg',
          ) /* ALLOW_FIXED_TMPDIR: missing on purpose */,
          mimeType: 'image/jpeg',
        },
      ],
      'eng',
    );

    expect(results).toHaveLength(1);
    // Routing invariant: the one shared definition, not a second inlined path.
    expect(createWorker).toHaveBeenCalledWith('eng', undefined, {
      cachePath: persistentCacheDir('tessdata'),
    });

    // Asserted independently of that helper, so this still fails if the helper
    // itself regresses: not the cwd (the bug cachePath exists to fix), and not
    // a predictable name in the SHARED temp dir, where any other local user
    // could plant a poisoned .traineddata (CodeQL js/insecure-temporary-file).
    const { cachePath } = createWorker.mock.calls[0][2] as { cachePath: string };
    expect(cachePath.startsWith(process.cwd())).toBe(false);
    expect(cachePath.startsWith(tmpdir())).toBe(false);
  });
});
