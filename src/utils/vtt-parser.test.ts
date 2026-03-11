import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES_DIR } from '../../test/helpers/index.js';
import { parseVtt } from './vtt-parser.js';

describe('parseVtt', () => {
  it('parses the sample.vtt fixture correctly', () => {
    const vtt = readFileSync(join(FIXTURES_DIR, 'sample.vtt'), 'utf-8');
    const entries = parseVtt(vtt);

    expect(entries).toHaveLength(5);
    expect(entries[0]).toEqual({
      time: '0:05',
      endTime: '0:12',
      text: 'So when I click add to cart, you can see the button highlights',
    });
  });

  it('extracts speaker tags', () => {
    const vtt = readFileSync(join(FIXTURES_DIR, 'sample.vtt'), 'utf-8');
    const entries = parseVtt(vtt);

    const withSpeaker = entries.find((e) => e.speaker);
    expect(withSpeaker).toBeDefined();
    expect(withSpeaker?.speaker).toBe('Guilherme');
    expect(withSpeaker?.text).toBe("Let me show you the console, there's an error here");
  });

  it('formats timestamps correctly (minutes:seconds)', () => {
    const vtt = readFileSync(join(FIXTURES_DIR, 'sample.vtt'), 'utf-8');
    const entries = parseVtt(vtt);

    expect(entries[0].time).toBe('0:05');
    expect(entries[0].endTime).toBe('0:12');
    expect(entries[4].time).toBe('0:30');
    expect(entries[4].endTime).toBe('0:35');
  });

  it('handles multi-line cue text', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:05.000
First line
Second line`;

    const entries = parseVtt(vtt);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('First line Second line');
  });

  it('strips HTML tags from text', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:05.000
This is <b>bold</b> and <i>italic</i> text`;

    const entries = parseVtt(vtt);
    expect(entries[0].text).toBe('This is bold and italic text');
  });

  it('returns empty array for empty VTT (header only)', () => {
    const entries = parseVtt('WEBVTT\n\n');
    expect(entries).toEqual([]);
  });

  it('returns empty array for malformed VTT (no timestamps)', () => {
    const entries = parseVtt('Some random text\nwithout any timestamps');
    expect(entries).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    const entries = parseVtt('');
    expect(entries).toEqual([]);
  });

  it('handles hours in timestamps', () => {
    const vtt = `WEBVTT

01:23:45.000 --> 01:24:00.500
Long video entry`;

    const entries = parseVtt(vtt);
    expect(entries[0].time).toBe('1:23:45');
    expect(entries[0].endTime).toBe('1:24:00');
  });

  it('skips NOTE comments', () => {
    const vtt = `WEBVTT

NOTE This is a comment

00:00:01.000 --> 00:00:05.000
Actual content`;

    const entries = parseVtt(vtt);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('Actual content');
  });

  it('skips sequence numbers', () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:05.000
First

2
00:00:05.000 --> 00:00:10.000
Second`;

    const entries = parseVtt(vtt);
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe('First');
    expect(entries[1].text).toBe('Second');
  });
});
