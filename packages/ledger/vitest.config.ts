import { defineConfig } from 'vitest/config';
// Default suite: hermetic only (unit + fast-check property). Integration
// (*.itest.ts) needs Docker — see vitest.integration.config.ts, run via
// `pnpm test:integration`.
export default defineConfig({ test: { exclude: ['**/node_modules/**', '**/dist/**', '**/*.itest.ts'] } });
