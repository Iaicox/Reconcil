import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      'ee/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Each package's tsconfig.test.json (a superset of its tsconfig.json:
        // adds "test", and "scripts" on the two packages that have one) is the
        // single project every `eslint src test[ scripts]` invocation needs —
        // projectService's directory-walking tsconfig.json discovery would miss
        // the test/scripts dirs entirely, since the build tsconfig.json stays
        // src-only by design (build graph / dist output must not include tests).
        project: ['./apps/*/tsconfig.test.json', './packages/*/tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
