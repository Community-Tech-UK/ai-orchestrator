import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.spec.ts', 'src/**/*.test.ts', 'packages/**/*.spec.ts', 'packages/**/*.test.ts', 'scripts/**/*.spec.ts'],
    exclude: ['src/**/*.bench.ts', 'src/**/*.load.ts'],
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
      '@contracts/schemas/common':          resolve(__dirname, './packages/contracts/src/schemas/common.schemas'),
      '@contracts/schemas/instance':        resolve(__dirname, './packages/contracts/src/schemas/instance.schemas'),
      '@contracts/schemas/session':         resolve(__dirname, './packages/contracts/src/schemas/session.schemas'),
      '@contracts/schemas/provider':        resolve(__dirname, './packages/contracts/src/schemas/provider.schemas'),
      '@contracts/schemas/orchestration':   resolve(__dirname, './packages/contracts/src/schemas/orchestration.schemas'),
      '@contracts/schemas/settings':        resolve(__dirname, './packages/contracts/src/schemas/settings.schemas'),
      '@contracts/schemas/file-operations': resolve(__dirname, './packages/contracts/src/schemas/file-operations.schemas'),
      '@contracts/schemas/security':        resolve(__dirname, './packages/contracts/src/schemas/security.schemas'),
      '@contracts/schemas/observability':   resolve(__dirname, './packages/contracts/src/schemas/observability.schemas'),
      '@contracts/schemas/workspace-tools': resolve(__dirname, './packages/contracts/src/schemas/workspace-tools.schemas'),
      '@contracts/schemas/knowledge':       resolve(__dirname, './packages/contracts/src/schemas/knowledge.schemas'),
      '@contracts/schemas/remote-node':     resolve(__dirname, './packages/contracts/src/schemas/remote-node.schemas'),
      '@contracts/schemas/plugin':          resolve(__dirname, './packages/contracts/src/schemas/plugin.schemas'),
      '@contracts/schemas/image':           resolve(__dirname, './packages/contracts/src/schemas/image.schemas'),
      '@contracts/schemas/quota':           resolve(__dirname, './packages/contracts/src/schemas/quota.schemas'),
      '@contracts/schemas/provider-runtime-events': resolve(__dirname, './packages/contracts/src/schemas/provider-runtime-events.schemas'),
      '@contracts/types/provider-runtime-events': resolve(__dirname, './packages/contracts/src/types/provider-runtime-events'),
      '@contracts/types/transport':         resolve(__dirname, './packages/contracts/src/types/transport.types'),
      '@contracts': resolve(__dirname, './packages/contracts/src'),
      '@sdk': resolve(__dirname, './packages/sdk/src'),
    },
  },
});
