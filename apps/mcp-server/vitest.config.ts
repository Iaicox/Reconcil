import { defineConfig } from 'vitest/config';
// Default suite: hermetic only. Integration (*.itest.ts) needs Docker — run via
// `pnpm test:integration` (vitest.integration.config.ts).
export default defineConfig({ test: { exclude: ['**/node_modules/**', '**/dist/**', '**/*.itest.ts'] } });
