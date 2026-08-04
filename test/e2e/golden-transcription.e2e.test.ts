import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAdapters, registerAdapter } from '../../src/adapters/adapter.interface.js';
import { LocalFileAdapter } from '../../src/adapters/local-file.adapter.js';
import { transcribeAudio } from '../../src/processors/audio-transcriber.js';
import { getAnalysis, resolveAnalyzeParams } from '../../src/tools/analyze-core.js';
import { SPEECH_WAV, SPEECH_WORDS, speechClip } from '../helpers/index.js';

/**
 * Transcript *outcome* tests against the committed speech fixture — the
 * transcript half of the "empty = FAIL" convention (issue #30, from the #28
 * post-mortem). Everywhere else in the suite an empty transcript is valid
 * graceful degradation; `speech.wav` has KNOWN words, so here empty = FAIL.
 *
 * Gate semantics (deliberate, per the issue):
 * - WHISPER_E2E unset → the suite is NOT collected. That's an explicit
 *   operator opt-out, visible in the suite name below — not a silent skip.
 * - WHISPER_E2E=1 + a whisper CLI present → the fixture MUST transcribe.
 * - WHISPER_E2E=1 + whisper missing → FAIL. There is no availability probe;
 *   a `describe.skipIf(whisperMissing)` here would be the "test that cannot
 *   fail" pattern CLAUDE.md forbids, wearing a costume.
 *
 * CI runs this with whisper-ctranslate2 (WHISPER_BIN=whisper-ctranslate2 —
 * the CLI candidate list is only [WHISPER_BIN, 'whisper']).
 */

// ASR output is noisy on case/punctuation; compare in a normalized space.
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const countRecovered = (text: string) => SPEECH_WORDS.filter((w) => text.includes(w)).length;

describe.runIf(process.env.WHISPER_E2E === '1')(
  'E2E: transcription outcome on golden speech (opt-in: WHISPER_E2E=1)',
  () => {
    beforeAll(() => {
      clearAdapters();
      registerAdapter(new LocalFileAdapter());
    });

    afterAll(() => {
      clearAdapters();
    });

    beforeEach(() => {
      // Ambient env would reroute or neutralize the guard: WHISPER_HF_MODEL or
      // OPENAI_API_KEY would let another backend pass the test with the whisper
      // CLI broken (a guard that cannot fail), WHISPER_LANGUAGE=pt would garble
      // the en-US fixture, and WHISPER_PROMPT could bias recognition. Keep
      // WHISPER_BIN/WHISPER_MODEL ambient: CI selects whisper-ctranslate2 via
      // WHISPER_BIN, and a dev's bigger model is result-equivalent.
      vi.stubEnv('WHISPER_HF_MODEL', '');
      vi.stubEnv('OPENAI_API_KEY', '');
      vi.stubEnv('WHISPER_LANGUAGE', '');
      vi.stubEnv('WHISPER_PROMPT', '');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    // The issue-#30 outcome guard: feed real speech to transcribeAudio and
    // assert the known words come back. Before this test, every transcription
    // assertion in the repo was `expect([])` on sine tones and silence.
    it('recovers the known words from the committed speech fixture', async () => {
      const warnings: string[] = [];
      const entries = await transcribeAudio(SPEECH_WAV, {}, (w) => warnings.push(w));

      // WHISPER_E2E=1 with no whisper CLI is a broken test environment, not a
      // pass and not a skip — fail loudly with the actionable warning.
      expect(warnings.join('\n')).not.toContain('No speech-to-text backend available');

      expect(entries.length).toBeGreaterThan(0);
      const text = norm(entries.map((e) => e.text).join(' '));
      // Whisper tiny transcribes the fixture verbatim (verified at generation
      // time); ≥3 of 5 tolerates minor ASR wobble without letting a collapse
      // ("", noise, wrong audio) pass.
      expect(countRecovered(text), `transcript was: "${text}"`).toBeGreaterThanOrEqual(3);
    });

    // Full-pipeline outcome: video with known speech → getAnalysis → whisper
    // fallback. Also the first happy-path coverage of extractAudioTrack, and
    // proof the silence gate does NOT fire on real speech (mean -20.6dB).
    it('getAnalysis recovers the speech via the Whisper fallback', async () => {
      const params = resolveAnalyzeParams({ detail: 'standard', forceRefresh: true });
      const { result, cleanup } = await getAnalysis(await speechClip(), params);
      try {
        expect(result.warnings.join('\n')).not.toContain('No speech-to-text backend available');
        expect(result.warnings.join('\n')).not.toContain('Audio track is silent');

        expect(result.transcript.length).toBeGreaterThan(0);
        const text = norm(result.transcript.map((e) => e.text).join(' '));
        expect(countRecovered(text), `transcript was: "${text}"`).toBeGreaterThanOrEqual(3);
      } finally {
        await cleanup();
      }
    });
  },
);
