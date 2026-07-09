import { defineConfig } from 'vitest/config';
import { aliases } from './vitest.aliases';

/** Slow / wall-clock specs — excluded from the default suite; run via `test:slow`. */
const slowTestGlobs = [
  'src/**/*.e2e.spec.ts',
  'src/**/*.e2e.test.ts',
  'src/**/soak.spec.ts',
  'src/**/soak.test.ts',
];

const defaultExcludes = [
  'src/**/*.bench.ts',
  'src/**/*.load.ts',
  ...slowTestGlobs,
];

export default defineConfig({
  test: {
    globals: true,
    // Multi-project: renderer gets Angular TestBed; everything else skips it
    // but still uses jsdom + zone.js (Worker/MessagePort + microtask fidelity).
    // Both stay singleFork until a dedicated isolation audit unlocks parallel
    // forks safely. CI still shards across jobs for wall-clock speed.
    projects: [
      {
        resolve: { alias: aliases },
        test: {
          name: 'renderer',
          globals: true,
          environment: 'jsdom',
          include: [
            'src/renderer/**/*.spec.ts',
            'src/renderer/**/*.test.ts',
            // Cross-layer smoke that boots Angular TestBed from scripts/.
            'scripts/__tests__/cross-wave-smoke.spec.ts',
          ],
          exclude: defaultExcludes,
          setupFiles: ['src/test-setup.ts'],
          pool: 'forks',
          poolOptions: {
            forks: {
              singleFork: true,
            },
          },
        },
      },
      {
        resolve: { alias: aliases },
        test: {
          name: 'main',
          globals: true,
          // jsdom (not node): plugin Worker hosts and several EventEmitter
          // recovery paths depend on jsdom/zone scheduling. Skipping Angular
          // TestBed is the main per-file setup win for this project.
          environment: 'jsdom',
          include: [
            'src/main/**/*.spec.ts',
            'src/main/**/*.test.ts',
            'src/shared/**/*.spec.ts',
            'src/shared/**/*.test.ts',
            'src/preload/**/*.spec.ts',
            'src/preload/**/*.test.ts',
            'src/worker-agent/**/*.spec.ts',
            'src/worker-agent/**/*.test.ts',
            'packages/**/*.spec.ts',
            'packages/**/*.test.ts',
            'scripts/**/*.spec.ts',
            'scripts/**/*.test.ts',
          ],
          exclude: [
            ...defaultExcludes,
            // Owned by the renderer project (needs Angular TestBed).
            'scripts/__tests__/cross-wave-smoke.spec.ts',
          ],
          setupFiles: ['src/test-setup-node.ts'],
          pool: 'forks',
          poolOptions: {
            forks: {
              singleFork: true,
            },
          },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/**/*.test.ts',
        'src/**/*.bench.ts',
        'src/**/*.load.ts',
        'src/**/*.types.ts',
        'src/renderer/**/*',
      ],
    },
    benchmark: {
      include: ['src/**/*.bench.ts'],
      exclude: ['node_modules'],
      reporters: ['default'],
      outputJson: './benchmark-results.json',
    },
  },
  resolve: {
    alias: aliases,
  },
});
