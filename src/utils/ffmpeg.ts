import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * The bundled ffmpeg-static binary: every ffmpeg this server runs, directly or
 * through yt-dlp (`--ffmpeg-location`) and whisper (`PATH`).
 */
export const ffmpegPath: string = require('ffmpeg-static') as string;

// The Linux ffmpeg-static build links glibc statically, and a static glibc
// segfaults when iconv reads the HOST's `gconv-modules.cache`. ffmpeg's MPEG-TS
// demuxer calls iconv_open on the SDT service name, so every MPEG-TS input
// crashed on probe: `.mts`/`.m2ts`, and since Nov 2026 Loom downloads, because
// Loom moved to HLS with `.ts` segments and yt-dlp's merge runs this binary
// ("ERROR: Postprocessing: libpostproc 58. 1.100" = last banner line, SIGSEGV).
//
// Any GCONV_PATH value makes glibc skip the cache and read the module config
// files instead; the crash is gone, and dynamically linked children still find
// the default modules dir, which glibc searches after this one. Process-wide so
// the ffmpeg that yt-dlp and whisper spawn inherits it and no call site can
// forget it. glibc loads modules from this dir, so it must be no more writable
// than the binary: ffmpeg-static's own dir. No-op where glibc isn't the libc.
if (ffmpegPath) process.env.GCONV_PATH ??= dirname(ffmpegPath);
