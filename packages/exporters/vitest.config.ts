import { defineConfig } from 'vitest/config';
// Hermetic only: exporters is pure (no db/fs/network), so there is no integration
// suite here — the export tools' Postgres integration lives in mcp-tools.
export default defineConfig({ test: { exclude: ['**/node_modules/**', '**/dist/**', '**/*.itest.ts'] } });
