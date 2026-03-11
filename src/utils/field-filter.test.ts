import { describe, expect, it } from 'vitest';
import type { IAnalysisResult } from '../types.js';
import { filterAnalysisResult } from './field-filter.js';

function createFullResult(): IAnalysisResult {
  return {
    metadata: {
      platform: 'loom',
      title: 'Test Video',
      duration: 120,
      durationFormatted: '2:00',
      url: 'https://www.loom.com/share/test123',
    },
    transcript: [{ time: '0:05', text: 'Hello world' }],
    frames: [{ time: '0:05', filePath: '/tmp/frame1.jpg', mimeType: 'image/jpeg' }],
    comments: [{ author: 'Alice', text: 'Great!', time: '0:10' }],
    chapters: [{ time: '0:00', title: 'Intro' }],
    ocrResults: [{ time: '0:05', text: 'Error 404', confidence: 85 }],
    timeline: [{ time: '0:05', seconds: 5, transcript: 'Hello world' }],
    aiSummary: 'A test video.',
    warnings: ['Some warning'],
  };
}

describe('filterAnalysisResult', () => {
  it('returns everything when fields is undefined', () => {
    const result = createFullResult();
    const filtered = filterAnalysisResult(result);
    expect(filtered).toEqual(result);
  });

  it('returns everything when fields is empty array', () => {
    const result = createFullResult();
    const filtered = filterAnalysisResult(result, []);
    expect(filtered).toEqual(result);
  });

  it('returns only metadata + warnings when fields=["metadata"]', () => {
    const result = createFullResult();
    const filtered = filterAnalysisResult(result, ['metadata']);

    expect(filtered.metadata).toEqual(result.metadata);
    expect(filtered.warnings).toEqual(result.warnings);
    expect(filtered.transcript).toBeUndefined();
    expect(filtered.frames).toBeUndefined();
    expect(filtered.comments).toBeUndefined();
    expect(filtered.ocrResults).toBeUndefined();
  });

  it('returns multiple requested fields', () => {
    const result = createFullResult();
    const filtered = filterAnalysisResult(result, ['transcript', 'frames']);

    expect(filtered.transcript).toEqual(result.transcript);
    expect(filtered.frames).toEqual(result.frames);
    expect(filtered.warnings).toEqual(result.warnings);
    expect(filtered.metadata).toBeUndefined();
    expect(filtered.comments).toBeUndefined();
  });

  it('always includes warnings regardless of field selection', () => {
    const result = createFullResult();
    const filtered = filterAnalysisResult(result, ['metadata']);
    expect(filtered.warnings).toEqual(['Some warning']);
  });

  it('handles all fields requested (same as no filter)', () => {
    const result = createFullResult();
    const allFields = [
      'metadata',
      'transcript',
      'frames',
      'comments',
      'chapters',
      'ocrResults',
      'timeline',
      'aiSummary',
    ] as const;
    const filtered = filterAnalysisResult(result, [...allFields]);

    expect(filtered.metadata).toEqual(result.metadata);
    expect(filtered.transcript).toEqual(result.transcript);
    expect(filtered.frames).toEqual(result.frames);
    expect(filtered.comments).toEqual(result.comments);
    expect(filtered.chapters).toEqual(result.chapters);
    expect(filtered.ocrResults).toEqual(result.ocrResults);
    expect(filtered.timeline).toEqual(result.timeline);
    expect(filtered.aiSummary).toEqual(result.aiSummary);
    expect(filtered.warnings).toEqual(result.warnings);
  });

  it('includes aiSummary when requested', () => {
    const result = createFullResult();
    const filtered = filterAnalysisResult(result, ['aiSummary']);
    expect(filtered.aiSummary).toBe('A test video.');
    expect(filtered.metadata).toBeUndefined();
  });
});
