import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findSidecarTranscript, srtToVtt } from './sidecar-transcripts.js';

describe('srtToVtt', () => {
  it('converts SRT timestamps and prepends the VTT header', () => {
    const srt = [
      '1',
      '00:00:01,500 --> 00:00:04,000',
      'Hello world.',
      '',
      '2',
      '00:00:05,000 --> 00:00:07,500',
      'Second line.',
    ].join('\n');

    const vtt = srtToVtt(srt);
    expect(vtt).toMatch(/^WEBVTT\n\n/);
    expect(vtt).toContain('00:00:01.500 --> 00:00:04.000');
    expect(vtt).toContain('00:00:05.000 --> 00:00:07.500');
    expect(vtt).toContain('Hello world.');
  });
});

describe('findSidecarTranscript', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sidecar-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeFixture(name: string, content: string): string {
    const path = join(tmp, name);
    writeFileSync(path, content);
    return path;
  }

  const sampleVtt = [
    'WEBVTT',
    '',
    '00:00:00.000 --> 00:00:02.000',
    'First.',
    '',
    '00:00:02.000 --> 00:00:04.000',
    'Second.',
  ].join('\n');

  const sampleSrt = [
    '1',
    '00:00:00,000 --> 00:00:02,000',
    'First.',
    '',
    '2',
    '00:00:02,000 --> 00:00:04,000',
    'Second.',
  ].join('\n');

  it('returns empty array when no sidecar exists', async () => {
    const videoPath = writeFixture('clip.mp4', 'fake');
    expect(await findSidecarTranscript(videoPath)).toEqual([]);
  });

  it('finds <stem>.vtt next to the video', async () => {
    const videoPath = writeFixture('clip.mp4', 'fake');
    writeFixture('clip.vtt', sampleVtt);

    const entries = await findSidecarTranscript(videoPath);
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe('First.');
    expect(entries[1].text).toBe('Second.');
  });

  it('finds <stem>.srt and converts it to entries', async () => {
    const videoPath = writeFixture('clip.mp4', 'fake');
    writeFixture('clip.srt', sampleSrt);

    const entries = await findSidecarTranscript(videoPath);
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe('First.');
  });

  it('prefers .vtt over .srt when both exist', async () => {
    const videoPath = writeFixture('clip.mp4', 'fake');
    writeFixture('clip.vtt', sampleVtt);
    writeFixture('clip.srt', '1\n00:00:99,000 --> 00:00:99,000\nWRONG.');

    const entries = await findSidecarTranscript(videoPath);
    expect(entries[0].text).toBe('First.');
  });

  it('finds language-suffixed variants like <stem>.en.vtt', async () => {
    const videoPath = writeFixture('clip.mp4', 'fake');
    writeFixture('clip.en.vtt', sampleVtt);

    const entries = await findSidecarTranscript(videoPath);
    expect(entries).toHaveLength(2);
  });

  it('prefers a direct <stem>.vtt over a language-suffixed variant', async () => {
    const videoPath = writeFixture('clip.mp4', 'fake');
    writeFixture('clip.vtt', sampleVtt);
    writeFixture('clip.en.vtt', 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nWRONG.\n');

    const entries = await findSidecarTranscript(videoPath);
    expect(entries[0].text).toBe('First.');
  });

  it('does not match unrelated siblings', async () => {
    const videoPath = writeFixture('clip.mp4', 'fake');
    writeFixture('other.vtt', sampleVtt);

    expect(await findSidecarTranscript(videoPath)).toEqual([]);
  });
});
