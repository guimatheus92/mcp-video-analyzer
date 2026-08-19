import type { ITranscriptEntry } from '../types.js';

const TIMESTAMP_LINE = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/;
const SPEAKER_TAG = /^<v\s+([^>]+)>(.*)<\/v>$/s;
// A tag only matches with its closing '>', so a single pass leaves an
// unterminated `<script src=x` fully intact (CodeQL
// js/incomplete-multi-character-sanitization). The second branch is what
// removes it. It covers '<' ONLY: WebVTT requires a literal '<' in cue text to
// be escaped as &lt;, so an unescaped one is always markup, but a literal '>'
// is legal unescaped cue text — '>> SPEAKER:' is the standard caption
// speaker-change marker, and '=>' / 'x > 3' are ordinary screencast prose.
const MARKUP_OR_STRAY_LT = /<[^>]*>|</g;

// The entities WebVTT allows in cue text. Decoded AFTER the strip, so an
// author-escaped `&lt;script&gt;` survives as literal text instead of being
// re-read as markup — and so text round-trips through transcriptToVtt(), which
// escapes '&' and '<' on the way out.
const CUE_ENTITIES = /&(amp|lt|gt|nbsp|lrm|rlm);/g;
const ENTITY_VALUES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  nbsp: '\u00a0',
  lrm: '\u200e',
  rlm: '\u200f',
};

function stripCueMarkup(value: string): string {
  // Strip to a fixed point: feeding the result back into the receiver is the
  // shape CodeQL js/incomplete-multi-character-sanitization requires, since it
  // flags any regex that can match `<script...>` regardless of the other
  // alternation branches. The '<' branch is what actually removes an
  // unterminated tag — the loop does not, and must not be relied on for it.
  let previous: string;
  do {
    previous = value;
    value = value.replace(MARKUP_OR_STRAY_LT, '');
  } while (value !== previous);
  return value.replace(CUE_ENTITIES, (_, name: string) => ENTITY_VALUES[name]);
}
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
    // SPEAKER_TAG's `[^>]+` capture excludes '>' but not '<', so the speaker
    // name can carry a `<script` of its own. It is public output too — it
    // reaches the MCP/CLI JSON and is written back out by transcriptToVtt —
    // so it goes through the same strip as the cue text.
    speaker = stripCueMarkup(speakerMatch[1]).trim();
    text = speakerMatch[2].trim();
  } else {
    text = joinedText;
  }

  text = stripCueMarkup(text).trim();

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
