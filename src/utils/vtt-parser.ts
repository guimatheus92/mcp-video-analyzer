import type { ITranscriptEntry } from '../types.js';

const TIMESTAMP_LINE = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/;
const SPEAKER_TAG = /^<v\s+([^>]+)>(.*)<\/v>$/s;
// A tag only matches with its closing '>', so a single pass leaves an
// unterminated `<script src=x` fully intact (CodeQL
// js/incomplete-multi-character-sanitization). The alternation drops any
// leftover angle bracket too: WebVTT cue text must escape a literal '<' as
// &lt; per spec, so no valid cue content is lost.
const HTML_TAGS = /<[^>]*>|[<>]/g;
const SEQUENCE_NUMBER = /^\d+$/;

export function parseVtt(vttContent: string): ITranscriptEntry[] {
  const lines = vttContent.split(/\r?\n/);
  const entries: ITranscriptEntry[] = [];

  let currentStart: string | null = null;
  let currentEnd: string | null = null;
  let currentTextLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === 'WEBVTT' || trimmed.startsWith('WEBVTT ')) {
      continue;
    }

    if (trimmed.startsWith('NOTE')) {
      continue;
    }

    if (SEQUENCE_NUMBER.test(trimmed)) {
      continue;
    }

    const timestampMatch = trimmed.match(TIMESTAMP_LINE);
    if (timestampMatch) {
      if (currentStart && currentTextLines.length > 0) {
        entries.push(buildEntry(currentStart, currentEnd, currentTextLines));
      }
      currentStart = timestampMatch[1];
      currentEnd = timestampMatch[2];
      currentTextLines = [];
      continue;
    }

    if (trimmed === '') {
      if (currentStart && currentTextLines.length > 0) {
        entries.push(buildEntry(currentStart, currentEnd, currentTextLines));
        currentStart = null;
        currentEnd = null;
        currentTextLines = [];
      }
      continue;
    }

    if (currentStart !== null) {
      currentTextLines.push(trimmed);
    }
  }

  if (currentStart && currentTextLines.length > 0) {
    entries.push(buildEntry(currentStart, currentEnd, currentTextLines));
  }

  return entries;
}

function buildEntry(
  startTimestamp: string,
  endTimestamp: string | null,
  textLines: string[],
): ITranscriptEntry {
  const joinedText = textLines.join(' ');

  let speaker: string | undefined;
  let text: string;

  const speakerMatch = joinedText.match(SPEAKER_TAG);
  if (speakerMatch) {
    speaker = speakerMatch[1].trim();
    text = speakerMatch[2].trim();
  } else {
    text = joinedText;
  }

  // Strip to a fixed point. The [<>] branch already guarantees no bracket
  // survives a single pass, so the second iteration is a confirmation rather
  // than work — but feeding the result back into the receiver is the shape
  // CodeQL js/incomplete-multi-character-sanitization requires (it flags any
  // regex that can match `<script...>`, alternation branches included), and
  // it keeps this correct if the bracket branch is ever narrowed.
  let previous: string;
  do {
    previous = text;
    text = text.replace(HTML_TAGS, '');
  } while (text !== previous);
  text = text.trim();

  const entry: ITranscriptEntry = {
    time: formatTimestamp(startTimestamp),
    text,
  };

  if (endTimestamp) {
    entry.endTime = formatTimestamp(endTimestamp);
  }

  if (speaker) {
    entry.speaker = speaker;
  }

  return entry;
}

function formatTimestamp(vttTimestamp: string): string {
  const parts = vttTimestamp.split(':');
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  const seconds = Math.floor(parseFloat(parts[2]));

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
