import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = join(fileURLToPath(import.meta.url), '..', '..');

/** The test/fixtures/ directory path. */
export const FIXTURES_DIR = join(TEST_DIR, 'fixtures');

/** Repository root. One anchor for both, so moving test/helpers/ can't split them. */
export const REPO_ROOT = join(TEST_DIR, '..');
