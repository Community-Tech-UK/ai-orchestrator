import { angularJitApplicationTransform } from '@angular/compiler-cli';
import ts from 'typescript';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

function angularJitPlugin(): Plugin {
  const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, '.');
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
  plugins: [angularJitPlugin()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.spec.ts', 'src/**/*.test.ts', 'scripts/**/*.spec.ts'],
    setupFiles: ['src/test-setup.ts'],
    // Node's experimental Web Storage globals shadow jsdom's implementation
    // with `undefined` unless a persistence file is configured. Disable the
    // Node globals in workers so browser tests receive jsdom localStorage.
    poolOptions: { forks: { execArgv: ['--no-experimental-webstorage'] } },
  },
});
