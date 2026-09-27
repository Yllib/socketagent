import tseslint from 'typescript-eslint';
import { fileURLToPath } from 'node:url';

export default [{
  ignores: ['node_modules/**', 'dist/**', 'plugins/**'],
}, {
  files: ['src/**/*.ts', 'test/**/*.{js,mjs}', 'scripts/**/*.{js,mjs}', 'eslint.config.mjs'],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      project: './tsconfig.type-safety.json',
      tsconfigRootDir: fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  plugins: { '@typescript-eslint': tseslint.plugin },
  linterOptions: { noInlineConfig: true },
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unsafe-assignment': 'error',
    '@typescript-eslint/no-unsafe-argument': 'error',
    '@typescript-eslint/no-unsafe-call': 'error',
    '@typescript-eslint/no-unsafe-member-access': 'error',
    '@typescript-eslint/no-unsafe-return': 'error',
    '@typescript-eslint/no-unsafe-type-assertion': 'error',
    '@typescript-eslint/ban-ts-comment': ['error', {
      'ts-ignore': true, 'ts-nocheck': true, 'ts-expect-error': true, 'ts-check': false,
    }],
  },
}];
