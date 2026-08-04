# Test fixtures — provenance & licensing

Attribution for the binary fixtures in this directory. The JSON/VTT/stderr
files are hand-written test data; `tiny.mp4`/`tiny.webm` are minimal
content-free clips (used where content must NOT matter — see the golden-clip
rationale in `test/helpers/golden-clips.ts`).

## `fonts/JetBrainsMono-Regular.ttf`

- **JetBrains Mono**, © 2020 The JetBrains Mono Project Authors
  (<https://github.com/JetBrains/JetBrainsMono>).
- Licensed under the SIL Open Font License 1.1 — full text in
  [`fonts/OFL.txt`](fonts/OFL.txt).
- Used as the fixed `fontfile=` for ffmpeg drawtext when rendering golden
  clips, so OCR-confidence floors stay stable across dev machines and CI
  without system font discovery.

## `speech.wav`

- Generated for this repo with Windows TTS (.NET `System.Speech`, voice
  "Microsoft Zira Desktop", rate −1) at 16kHz/16-bit/mono — the exact format
  `extractAudioTrack()` produces. Synthetic speech, not a recording of a
  person; no third-party license applies.
- Spoken text: **"The quick brown fox jumps over the lazy dog."** (3.63s,
  `mean_volume: -20.6dB` — safely above the −55dB silence gate).
- Ground truth the outcome tests assert against: `SPEECH_WORDS` in
  `test/helpers/golden-clips.ts`.
- To regenerate: speak the same sentence into a 16kHz/16-bit/mono WAV and
  re-verify with a local whisper (`whisper speech.wav --model tiny`). The
  `speechClip()` mux self-invalidates via the WAV's content hash.
