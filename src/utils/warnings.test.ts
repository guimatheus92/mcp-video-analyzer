import { describe, expect, it } from 'vitest';
import { warningReason } from './warnings.js';

/**
 * The real shape of what reached `warnings[]` in issue #46: Node's `execFile`
 * rejection, whose `message` is the whole argv and whose `stderr` is the ffmpeg
 * banner plus a stream dump, with the actual reason on the last two lines.
 */
function ffmpegRejection(): Error & { stderr: string } {
  const ffmpeg =
    'C:\\Users\\guilh\\repos\\mcp-video-analyzer\\node_modules\\ffmpeg-static\\ffmpeg.exe';
  const input = 'C:\\Users\\guilh\\AppData\\Local\\Temp\\mcp-video-vX0SEY\\clip.mp4';
  const output = 'C:\\Users\\guilh\\AppData\\Local\\Temp\\mcp-video-vX0SEY\\audio.wav';
  const error = new Error(
    `Command failed: ${ffmpeg} -i ${input} -vn -acodec pcm_s16le -ar 16000 -ac 1 ${output} -y`,
  ) as Error & { stderr: string };
  error.stderr = [
    'ffmpeg version 6.1.1-essentials_build-www.gyan.dev Copyright (c) 2000-2023 the FFmpeg developers',
    '  built with gcc 12.2.0 (Rev10, Built by MSYS2 project)',
    '  configuration: --enable-gpl --enable-version3 --enable-static --pkg-config=pkgconf',
    `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '${input}':`,
    '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 640x360',
    `Output #0, wav, to '${output}':`,
    '[out#0/wav @ 000001fe5c236b00] Output file does not contain any stream',
    `Error opening output file ${output}.`,
  ].join('\r\n');
  return error;
}

describe('warningReason', () => {
  it('reduces the ffmpeg dump from #46 to one path-free line', () => {
    const reason = warningReason(ffmpegRejection());

    expect(reason).not.toContain('\n');
    expect(reason.length).toBeLessThanOrEqual(300);
    // The three things that made the original unfit for user-visible output.
    expect(reason).not.toMatch(/-acodec|pcm_s16le|ffmpeg version/);
    expect(reason).not.toMatch(/[A-Za-z]:\\/);
    expect(reason).not.toContain('Users');
    // And it still says what went wrong.
    expect(reason).toMatch(/opening output file|does not contain any stream/i);
  });

  it('leaves a crafted single-line hint exactly as it was', () => {
    // Verbatim shape of extractYtDlpError()'s output: long, but every character
    // of it is the actionable half. Truncating or rewriting it would regress
    // the fix that put it there.
    const hint =
      'ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm your age. This video may be ' +
      'inappropriate for some users. — this content likely requires authentication: set ' +
      'YTDLP_COOKIES=<Netscape cookie file> or YTDLP_COOKIES_FROM_BROWSER=chrome (on Windows ' +
      'the browser must be closed).';

    expect(warningReason(new Error(hint))).toBe(hint);
  });

  it('leaves the sentences the dedicated translators already produce', () => {
    for (const sentence of [
      'This video has no audio track.',
      'Audio extraction failed: the video file is no longer on disk.',
      'ffmpeg crashed (SIGSEGV) while reading .mts — the bundled ffmpeg binary cannot demux this container on this platform. Convert the file to .mp4 or .mkv and retry.',
    ]) {
      expect(warningReason(new Error(sentence))).toBe(sentence);
    }
  });

  it('keeps a URL, which is the user own input and the useful part', () => {
    const error = new Error(
      'Command failed: fetch\nrequest to https://cdn.loom.com/sessions/abc.mp4 failed, reason: socket hang up',
    );

    expect(warningReason(error)).toContain('https://cdn.loom.com/sessions/abc.mp4');
  });

  it('redacts a POSIX path without touching the rest of the line', () => {
    const error = new Error('Input file is missing: /tmp/mcp-video-abc/frame_0001.jpg');

    expect(warningReason(error)).toBe('Input file is missing: <path>');
  });

  it('truncates a single line that is long enough to be a dump', () => {
    const reason = warningReason(new Error('x'.repeat(500)));

    expect(reason).toHaveLength(300);
    expect(reason.endsWith('…')).toBe(true);
  });

  it('handles a non-Error throw', () => {
    expect(warningReason('boom')).toBe('boom');
    expect(warningReason(undefined)).toBe('undefined');
  });
});
