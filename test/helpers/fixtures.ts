import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = join(fileURLToPath(import.meta.url), '..', '..');

/** The test/fixtures/ directory path. */
export const FIXTURES_DIR = join(TEST_DIR, 'fixtures');
