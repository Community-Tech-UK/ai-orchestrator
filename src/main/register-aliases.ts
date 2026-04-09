/**
 * Registers TypeScript path aliases for Node.js runtime resolution.
 *
 * tsc does not rewrite path aliases (e.g. @contracts/*) in emitted JS.
 * This module hooks into Node's module resolver so that require('@contracts/...')
 * resolves to the compiled output under dist/packages/.
 *
 * MUST be required before any module that uses path aliases.
 */

import * as path from 'path';

const aliases: Record<string, string> = {
  '@contracts': path.join(__dirname, '..', 'packages', 'contracts', 'src'),
  '@sdk': path.join(__dirname, '..', 'packages', 'sdk', 'src'),
  '@shared': path.join(__dirname, '..', 'shared'),
};

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const NativeModule = require('module') as any;

const originalResolveFilename: (...args: unknown[]) => string =
  NativeModule._resolveFilename.bind(NativeModule);

function resolveFilename(request: string, ...rest: unknown[]): string {
  for (const [alias, target] of Object.entries(aliases)) {
    if (request === alias) {
      return originalResolveFilename(target, ...rest);
    }
    if (request.startsWith(alias + '/')) {
      return originalResolveFilename(
        path.join(target, request.slice(alias.length + 1)),
        ...rest,
      );
    }
  }
  return originalResolveFilename(request, ...rest);
}

Object.defineProperty(NativeModule, '_resolveFilename', {
  value: resolveFilename,
  writable: true,
  configurable: true,
});
