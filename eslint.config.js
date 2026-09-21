// Flat ESLint config for the SIH2026 PS171 browser agent (issue #126 item 2).
//
// Scope: lint the extension source tree (src/**) only. Dev/verify scripts
// under scripts/, ad_pipeline/ and the gitignored scratch dirs are excluded.
//
// Design choices:
//  - typescript-eslint recommended (ESLint core rules are auto-adjusted for
//    TS files by the flat config - no-undef etc. are off where the checker
//    works).
//  - WXT injects ambient globals (browser, wxt, defineBackground, ...) that
//    only exist at build time, so raw `tsc`/`eslint` can't see them - we
//    declare them as readonly globals here instead of sprinkling
//    eslint-disable comments.
//  - @typescript-eslint/no-explicit-any is WARN (not error): the codebase
//    still has ~71 legacy `any` sites (see issue #126 item 3); warnings keep
//    CI green while the debt is paid down, and the count is actionable.
//  - eslint-config-prettier last: kills stylistic conflicts so Prettier owns
//    formatting.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

// WXT-injected ambient globals (src/env.d.ts + wxt/sandbox re-exports).
const wxtGlobals = {
  browser: 'readonly',
  wxt: 'readonly',
  defineBackground: 'readonly',
  defineContentScript: 'readonly',
  defineUnlistedEntry: 'readonly',
  defineWxtMessage: 'readonly',
  __SERVER_URL__: 'readonly',
};

export default tseslint.config(
  {
    // Global ignore entry: first object may contain only `ignores`.
    ignores: [
      'dist/',
      '.output/',
      'node_modules/',
      'public/',
      'docs/',
      'dev/',
      'logs/',
      'shots/',
      'test-results/',
      'screenshots/',
      'ad_pipeline/',
      '.hermes/',
      'scripts/',
      'server/',
      'tests/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...wxtGlobals,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Console is legitimate diagnostic plumbing in a browser extension
      // (background/content scripts surface via the DevTools console - that
      // IS the user-facing log channel). Keep the rule available but off by
      // default; hot-path console spam is tracked in #126 item 6 instead.
      'no-console': 'off',
    },
  },
  // Must be last so Prettier turns off conflicting style rules.
  prettierConfig,
);
