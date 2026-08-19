# Security Policy

## Supported versions

This project ships from `main` as a single release line: only the latest
version published to npm (`npm view mcp-video-analyzer version`) receives
security fixes. Older versions are not patched — upgrade instead.

## Reporting a vulnerability

Report privately through GitHub, **not** in a public issue:

[**Report a vulnerability**](https://github.com/guimatheus92/mcp-video-analyzer/security/advisories/new)
(repository → Security → Advisories → *Report a vulnerability*)

Please include the affected version, a reproduction, and the impact you
observed. Expect an acknowledgement within 7 days; a fix ships as a patch
release with a published advisory crediting the reporter unless you ask
otherwise.

## Scope

This server runs locally and drives external binaries and network sources, so
these are the parts worth looking at:

- command construction around the spawned binaries (`yt-dlp`, the bundled
  `ffmpeg-static`, the whisper CLI) — argument injection through a URL, a file
  path, or an env var;
- path handling for downloads, temp files and sidecars written next to local
  videos (`MCP_WRITE_SIDECARS`);
- credential handling for `YTDLP_COOKIES` / `YTDLP_COOKIES_FROM_BROWSER`,
  `OPENAI_API_KEY` and `TWELVELABS_API_KEY` — these must never reach stdout,
  a warning, or an analysis sidecar.

Out of scope: vulnerabilities in `yt-dlp`, ffmpeg, whisper or any other
external tool the user installs — report those upstream. Dependency advisories
are already tracked by the `Security` workflow (`npm audit`) and Dependabot;
open a normal issue if one is missed.
