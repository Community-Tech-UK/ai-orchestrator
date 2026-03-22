import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
    exclude: ['src/**/*.bench.ts', 'src/**/*.load.ts', 'src/main/channels/__tests__/whatsapp-adapter.spec.ts'],
    setupFiles: ['src/test-setup.ts'],
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
    // Avoid re-initializing TestBed for each file
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Benchmark configuration (used when running `vitest bench`)
    benchmark: {
      include: ['src/**/*.bench.ts'],
      exclude: ['node_modules'],
      reporters: ['default'],
      outputJson: './benchmark-results.json',
    },
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, './src/shared'),
    },
  },
});
