import { describe, expect, it } from 'vitest';
import { isMeaningfulOcr } from './frame-ocr.js';

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
