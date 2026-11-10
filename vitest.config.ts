import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'tests/unit/**/*.test.ts'], testTimeout: 30_000 } });
