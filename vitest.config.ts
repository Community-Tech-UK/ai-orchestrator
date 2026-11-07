import { angularJitApplicationTransform } from '@angular/compiler-cli';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { aliases } from './vitest.aliases';
import { testHeapExecArgv } from './vitest.heap';
import { resolveTestMaxForks } from './vitest.pool';

// Every test file starts a fresh process, which would otherwise compile the same libraries
// again: about 5% of a full run's processor time. Workers inherit this. Node checks each
// entry against its source, so a stale one is ignored.
process.env['NODE_COMPILE_CACHE'] ??= fileURLToPath(new URL('./node_modules/.cache/node-compile-cache', import.meta.url));

function angularJitPlugin(): Plugin {
  // Parsing all 4,000 source files costs a few seconds, so only a run that reaches a
  // renderer file pays for it. Most runs don't, and there are hundreds a day.
  let compiler: { options: ts.CompilerOptions; program: ts.Program } | undefined;
  const loadCompiler = () => {
    const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
    if (config.error) {
      throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    }
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, '.');
    return { options: parsed.options, program: ts.createProgram(parsed.fileNames, parsed.options) };
  };

  return {
    name: 'aio-angular-jit-transform',
    enforce: 'pre',
    transform(code, id) {
      const fileName = id.split('?', 1)[0];
      if (!fileName.includes('/src/renderer/') || !fileName.endsWith('.ts')) {
        return null;
      }

      compiler ??= loadCompiler();
      const result = ts.transpileModule(code, {
        fileName,
        compilerOptions: {
          ...compiler.options,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          sourceMap: true,
          inlineSources: true,
        },
        transformers: {
          before: [angularJitApplicationTransform(compiler.program)],
        },
      });
      return {
        code: result.outputText,
        map: result.sourceMapText ?? null,
      };
    },
  };
}

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

// Suites that exercise main and renderer together live outside production
// renderer boundaries, but still need Angular TestBed and renderer transforms.
const rendererIntegrationTestGlobs = [
  'src/tests/renderer-integration/**/*.spec.ts',
  'src/tests/renderer-integration/**/*.test.ts',
];

export default defineConfig({
  test: {
    globals: true,
    // Vitest 5 clears mocks between tests by default. Specs here were written to set a
    // mock up once for a whole file, so keep them as they are.
    clearMocks: false,
    // Vitest 5 keeps transformed files on disk between runs. Measured on 7 November 2026 it
    // saved under 1% here, and renderer output depends on other files' types, which its key
    // doesn't cover, so a warm entry could be wrong.
    fsModuleCache: false,
    // Vitest caps the whole run with maxWorkers; worker arguments belong to
    // each project. Preserve the host-aware cap and heap budget after removing
    // the old poolOptions API. See vitest.heap.ts and vitest.pool.ts.
    maxWorkers: resolveTestMaxForks(),
    // Multi-project: renderer gets Angular TestBed and jsdom; everything else
    // runs in plain Node, keeping zone.js for its microtask scheduling.
    // Neither project is singleFork — files run in parallel, isolated forks, so
    // no worker accumulates a whole project's retained state. CI still shards
    // across jobs on top of this.
    projects: [
      {
        plugins: [angularJitPlugin()],
        resolve: { alias: aliases },
        test: {
          name: 'renderer',
          globals: true,
          environment: 'jsdom',
          include: [
            'src/renderer/**/*.spec.ts',
            'src/renderer/**/*.test.ts',
            ...rendererIntegrationTestGlobs,
            // Cross-layer smoke that boots Angular TestBed from scripts/.
            'scripts/__tests__/cross-wave-smoke.spec.ts',
          ],
          exclude: defaultExcludes,
          setupFiles: ['src/test-setup.ts'],
          pool: 'forks',
          execArgv: testHeapExecArgv(),
        },
      },
      {
        resolve: { alias: aliases },
        test: {
          name: 'main',
          globals: true,
          // Most of these files test code with no web page, and building a
          // simulated browser for each one was about a quarter of a full run.
          // A spec that needs one opts in with `// @vitest-environment jsdom`.
          environment: 'node',
          include: [
            'src/main/**/*.spec.ts',
            'src/main/**/*.test.ts',
            'src/shared/**/*.spec.ts',
            'src/shared/**/*.test.ts',
            'src/preload/**/*.spec.ts',
            'src/preload/**/*.test.ts',
            'src/worker-agent/**/*.spec.ts',
            'src/worker-agent/**/*.test.ts',
            'src/tests/**/*.spec.ts',
            'src/tests/**/*.test.ts',
            'packages/**/*.spec.ts',
            'packages/**/*.test.ts',
            'scripts/**/*.spec.ts',
            'scripts/**/*.test.ts',
          ],
          exclude: [
            ...defaultExcludes,
            // Owned by the renderer project (needs Angular TestBed).
            ...rendererIntegrationTestGlobs,
            'scripts/__tests__/cross-wave-smoke.spec.ts',
          ],
          setupFiles: ['src/test-setup-node.ts'],
          pool: 'forks',
          execArgv: testHeapExecArgv(),
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
    },
  },
  resolve: {
    alias: aliases,
  },
});
