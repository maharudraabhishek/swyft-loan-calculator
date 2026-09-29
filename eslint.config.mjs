import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/coverage/**',
      '**/node_modules/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/desktop/scripts/*.mjs', 'apps/api/scripts/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        WebSocket: 'readonly',
        Buffer: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['packages/finance/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'electron',
                'react',
                'react-dom',
                'fastify',
                '@google-cloud/*',
                'pg',
              ],
              message:
                'The finance domain must not depend on delivery or infrastructure packages.',
            },
            {
              group: ['node:*'],
              message: 'The finance domain must remain runtime independent.',
            },
          ],
        },
      ],
    },
  },
);
