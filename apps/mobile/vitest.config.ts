import { angularJitApplicationTransform } from '@angular/compiler-cli';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { resolveTestMaxForks } from '../../vitest.pool';

// Anchored to this file, so resolution does not depend on the working folder.
const configDir = fileURLToPath(new URL('.', import.meta.url));
const tsConfig = ts.readConfigFile(join(configDir, 'tsconfig.json'), ts.sys.readFile);
if (tsConfig.error) {
  throw new Error(ts.flattenDiagnosticMessageText(tsConfig.error.messageText, '\n'));
}
const parsed = ts.parseJsonConfigFileContent(tsConfig.config, ts.sys, configDir);

/**
 * Resolve `@contracts/...` through tsconfig `paths`, exactly as the phone's
 * type check and build do. Type-only imports vanish when compiled, but a value
 * re-exported through one (for example the shared mobile-gateway types) must
 * resolve at test time too.
 */
function tsconfigPathsPlugin(): Plugin {
  return {
    name: 'harness-mobile-tsconfig-paths',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('@contracts/')) return null;
      const resolved = ts.resolveModuleName(source, importer.split('?', 1)[0], parsed.options, ts.sys).resolvedModule;
      if (!resolved) throw new Error(`tsconfig paths do not resolve ${source} from ${importer}`);
      return resolved.resolvedFileName;
    },
  };
}

function angularJitPlugin(): Plugin {
  const program = ts.createProgram(parsed.fileNames, parsed.options);

  return {
    name: 'harness-mobile-angular-jit-transform',
    enforce: 'pre',
    transform(code, id) {
      const fileName = id.split('?', 1)[0];
      const normalizedFileName = fileName.replaceAll('\\', '/');
      if (!normalizedFileName.includes('/apps/mobile/src/') || !fileName.endsWith('.ts')) {
        return null;
      }

      const result = ts.transpileModule(code, {
        fileName,
        compilerOptions: {
          ...parsed.options,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          sourceMap: true,
          inlineSources: true,
        },
        transformers: {
          before: [angularJitApplicationTransform(program)],
        },
      });
      return {
        code: result.outputText,
        map: result.sourceMapText ?? null,
      };
    },
  };
}

export default defineConfig({
  plugins: [tsconfigPathsPlugin(), angularJitPlugin()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.spec.ts', 'src/**/*.test.ts', 'scripts/**/*.spec.ts'],
    setupFiles: ['src/test-setup.ts'],
    // The root suite's load-aware cap. The default (every core but one) let 17
    // DOM-heavy jsdom workers fight a busy host until transcript tests overran.
    maxWorkers: resolveTestMaxForks(),
    // Node's experimental Web Storage globals shadow jsdom's implementation
    // with `undefined` unless a persistence file is configured. Disable the
    // Node globals in workers so browser tests receive jsdom localStorage.
    // (Vitest 4 moved this from `poolOptions.forks`, which it now ignores.)
    execArgv: ['--no-experimental-webstorage'],
  },
});
