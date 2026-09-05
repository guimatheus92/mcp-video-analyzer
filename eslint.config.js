import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
    },
  },
  {
    // `.cache/` holds the golden clips the e2e suite renders. `.mts` is both a
    // TypeScript module extension and the AVCHD container in VIDEO_EXTENSIONS,
    // so eslint tries to parse a real MPEG-TS file as source and `npm run
    // check` fails on any machine that has run e2e. Same collision the `.ts`
    // exclusion in url-detector.ts already documents, one directory over.
    ignores: ['dist/', 'node_modules/', '.cache/', '*.config.*'],
  },
);
