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
        // tsconfig.scripts.json covers the root `scripts/` TS that belongs to no package —
        // without it those files parse-error under type-aware rules rather than being linted.
        project: [
          './apps/*/tsconfig.test.json',
          './packages/*/tsconfig.test.json',
          './tsconfig.scripts.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Root CommonJS tooling — the supply-chain guard that enforces ADR-011, its test, and
    // the dependency-cruiser config it reads its banned list from. These belong to no
    // workspace package, so no `eslint src test` invocation ever reached them and no
    // tsconfig project includes them: CI executes them (`pnpm test:scripts`, `depcruise`,
    // `check:supply-chain`) but nothing checked them statically. They are plain CJS, so
    // type-aware rules are switched off rather than given a project.
    files: ['scripts/**/*.cjs', '.dependency-cruiser.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    // These files are .cjs on purpose (node --test / dependency-cruiser both load them as
    // CommonJS), so require() is the correct call here, not a lapse.
    rules: { '@typescript-eslint/no-require-imports': 'off' },
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },
);
