/**
 * Slow-tier Vitest config — e2e + soak only.
 *
 * Kept separate from the default multi-project config so those wall-clock
 * tests stay out of `npm test` / pre-push while remaining easy to run via
 * `npm run test:slow` (and the CI `test-slow` job).
 */

import { defineConfig } from 'vitest/config';
import { aliases } from './vitest.aliases';

export default defineConfig({
  test: {
    name: 'slow',
    globals: true,
    environment: 'node',
    include: [
      'src/**/*.e2e.spec.ts',
      'src/**/*.e2e.test.ts',
      'src/**/soak.spec.ts',
      'src/**/soak.test.ts',
    ],
    setupFiles: ['src/test-setup-node.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        // Real git / FS soak work is heavy; keep serial to avoid repo contention.
        singleFork: true,
      },
    },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: aliases,
  },
});
