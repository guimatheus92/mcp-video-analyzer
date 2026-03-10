import type { IAnalysisResult } from '../types.js';

export type AnalysisField =
  | 'metadata'
  | 'transcript'
  | 'frames'
  | 'comments'
  | 'chapters'
  | 'ocrResults'
  | 'timeline'
  | 'aiSummary';

const ALL_FIELDS: AnalysisField[] = [
  'metadata',
  'transcript',
  'frames',
  'comments',
  'chapters',
  'ocrResults',
  'timeline',
  'aiSummary',
];

/**
 * Filter an analysis result to only include the requested fields.
 * `warnings` is always included regardless of field selection.
 * If `fields` is undefined or empty, returns the full result.
 */
export function filterAnalysisResult(
  result: IAnalysisResult,
  fields?: AnalysisField[],
): Partial<IAnalysisResult> & { warnings: string[] } {
  if (!fields || fields.length === 0) {
    return result;
  }

  const filtered: Partial<IAnalysisResult> & { warnings: string[] } = {
    warnings: result.warnings,
  };

  const fieldSet = new Set(fields);

  for (const field of ALL_FIELDS) {
    if (fieldSet.has(field)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (filtered as any)[field] = result[field];
    }
  }

  return filtered;
}
