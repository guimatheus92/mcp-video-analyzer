import type { IFrameResult } from '../types.js';

export interface IOcrResult {
  time: string;
  text: string;
  confidence: number;
}

/**
 * Extract text from video frames using OCR (tesseract.js).
 * Useful for screencasts, code demos, error messages, and UI text.
 *
 * Only includes results with meaningful text (confidence > 50%, text length > 3).
 */
export async function extractTextFromFrames(
  frames: IFrameResult[],
  language = 'eng+por',
): Promise<IOcrResult[]> {
  const Tesseract = await loadTesseract();
  if (!Tesseract) return [];

  const worker = await Tesseract.createWorker(language);

  try {
    const results: IOcrResult[] = [];

    for (const frame of frames) {
      try {
        const {
          data: { text, confidence },
        } = await worker.recognize(frame.filePath);

        const cleaned = text.trim();
        if (cleaned.length > 3 && confidence > 50) {
          results.push({
            time: frame.time,
            text: cleaned,
            confidence: Math.round(confidence),
          });
        }
      } catch {
        // Skip frames that fail OCR
      }
    }

    return results;
  } finally {
    await worker.terminate();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadTesseract(): Promise<any> {
  try {
    return await import('tesseract.js');
  } catch {
    return null;
  }
}
