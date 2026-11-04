// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/node_modules/**', 'coverage/**', '**/dist/**', 'fixtures/**'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
  {
    // Library code is platform-neutral: it runs in the renderer, in workers and in Node tests.
    files: ['packages/*/src/**/*.ts'],
    ignores: ['packages/testkit/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'packages/* must not touch the DOM; inject what you need.' },
        { name: 'document', message: 'packages/* must not touch the DOM; inject what you need.' },
        { name: 'navigator', message: 'packages/* must not touch the DOM; inject what you need.' },
        { name: 'localStorage', message: 'Persistence belongs to the desktop shell.' },
        { name: 'process', message: 'packages/* must not depend on Node globals.' },
        { name: 'Buffer', message: 'Use Uint8Array; packages/* must not depend on Node globals.' },
      ],
    },
  },
  {
    files: ['**/test/**/*.ts'],
    rules: {
      // assertions on parsed test data are clearer without non-null ceremony
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
  prettier,
);
