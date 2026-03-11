import { describe, expect, it } from 'vitest';
import type { IFrameResult, ITranscriptEntry } from '../types.js';
import { buildAnnotatedTimeline, parseTimeToSeconds } from './annotated-timeline.js';
import type { IOcrResult } from './frame-ocr.js';

describe('annotated-timeline', () => {
  describe('parseTimeToSeconds', () => {
    it('parses M:SS format', () => {
      expect(parseTimeToSeconds('1:23')).toBe(83);
    });

    it('parses H:MM:SS format', () => {
      expect(parseTimeToSeconds('1:02:03')).toBe(3723);
    });

    it('parses 0:00', () => {
      expect(parseTimeToSeconds('0:00')).toBe(0);
    });

    it('returns 0 for invalid format', () => {
      expect(parseTimeToSeconds('invalid')).toBe(0);
    });
  });

  describe('buildAnnotatedTimeline', () => {
    it('returns empty array for no data', () => {
      const result = buildAnnotatedTimeline([], [], []);
      expect(result).toEqual([]);
    });

    it('includes transcript entries', () => {
      const transcript: ITranscriptEntry[] = [
        { time: '0:05', text: 'Hello world' },
        { time: '0:12', text: 'Next point', speaker: 'Alice' },
      ];

      const result = buildAnnotatedTimeline(transcript, [], []);
      expect(result).toHaveLength(2);
      expect(result[0].transcript).toBe('Hello world');
      expect(result[0].seconds).toBe(5);
      expect(result[1].speaker).toBe('Alice');
    });

    it('merges frame timestamps with nearby transcript entries', () => {
      const transcript: ITranscriptEntry[] = [{ time: '0:05', text: 'Looking at the code' }];
      const frames: IFrameResult[] = [
        { time: '0:06', filePath: '/f1.jpg', mimeType: 'image/jpeg' },
      ];

      const result = buildAnnotatedTimeline(transcript, frames, []);
      // Frame at 0:06 should merge with transcript at 0:05 (within 2s tolerance)
      expect(result).toHaveLength(1);
      expect(result[0].transcript).toBe('Looking at the code');
      expect(result[0].frameIndex).toBe(0);
    });

    it('creates separate entry for frames far from transcript', () => {
      const transcript: ITranscriptEntry[] = [{ time: '0:05', text: 'First point' }];
      const frames: IFrameResult[] = [
        { time: '0:30', filePath: '/f1.jpg', mimeType: 'image/jpeg' },
      ];

      const result = buildAnnotatedTimeline(transcript, frames, []);
      expect(result).toHaveLength(2);
      expect(result[0].seconds).toBe(5);
      expect(result[1].seconds).toBe(30);
      expect(result[1].frameIndex).toBe(0);
    });

    it('merges OCR text with existing entries', () => {
      const transcript: ITranscriptEntry[] = [{ time: '0:10', text: 'See the error' }];
      const frames: IFrameResult[] = [
        { time: '0:10', filePath: '/f1.jpg', mimeType: 'image/jpeg' },
      ];
      const ocr: IOcrResult[] = [
        { time: '0:11', text: 'TypeError: undefined is not a function', confidence: 90 },
      ];

      const result = buildAnnotatedTimeline(transcript, frames, ocr);
      expect(result).toHaveLength(1);
      expect(result[0].transcript).toBe('See the error');
      expect(result[0].frameIndex).toBe(0);
      expect(result[0].ocrText).toBe('TypeError: undefined is not a function');
    });

    it('sorts entries chronologically', () => {
      const transcript: ITranscriptEntry[] = [
        { time: '0:20', text: 'Later' },
        { time: '0:05', text: 'Earlier' },
      ];
      const frames: IFrameResult[] = [
        { time: '0:12', filePath: '/f1.jpg', mimeType: 'image/jpeg' },
      ];

      const result = buildAnnotatedTimeline(transcript, frames, []);
      expect(result[0].seconds).toBe(5);
      expect(result[1].seconds).toBe(12);
      expect(result[2].seconds).toBe(20);
    });
  });
});
