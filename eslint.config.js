import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'coverage/**', 'test/tmp/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Unused args: allow leading underscore (e.g. `_req`, `_params`).
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // The in-page injected functions are stringified and run in the browser,
      // so `document`/`window`/etc. are legitimately undefined at lint time.
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'object-shorthand': ['error', 'always'],
      'no-throw-literal': 'error',
    },
  },
  {
    // Injected browser scripts reference browser globals inside stringified fns.
    files: ['src/observe.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    // Test + example scripts are plain Node ESM.
    files: ['test/**/*.mjs', 'examples/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
