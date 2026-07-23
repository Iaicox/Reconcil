import { defineConfig } from 'vitest/config';
// Default suite: hermetic only (dataset loader + deterministic graders). Integration
// (*.itest.ts, the golden-wallet reconciliation) needs Docker — see
// vitest.integration.config.ts, run via `pnpm test:integration`.
export default defineConfig({ test: { exclude: ['**/node_modules/**', '**/dist/**', '**/*.itest.ts'] } });
