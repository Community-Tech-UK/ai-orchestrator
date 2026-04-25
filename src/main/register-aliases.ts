/**
 * Registers TypeScript path aliases for Node.js runtime resolution.
 *
 * tsc does not rewrite path aliases (e.g. @contracts/*) in emitted JS.
 * This module hooks into Node's module resolver so that require('@contracts/...')
 * resolves to the compiled output under dist/packages/.
 *
 * MUST be required before any module that uses path aliases.
 *
 * Keep `exactAliases` in sync with the non-wildcard entries in
 * tsconfig.electron.json > compilerOptions.paths, since those point to files
 * whose on-disk name differs from the import path (e.g. `.schemas`/`.types`
 * suffixes).
 */

import * as path from 'path';

const baseContracts = path.join(__dirname, '..', 'packages', 'contracts', 'src');
const baseSdk = path.join(__dirname, '..', 'packages', 'sdk', 'src');
const baseShared = path.join(__dirname, '..', 'shared');

const exactAliases: Record<string, string> = {
  '@contracts/schemas/common':                  path.join(baseContracts, 'schemas', 'common.schemas'),
  '@contracts/schemas/instance':                path.join(baseContracts, 'schemas', 'instance.schemas'),
  '@contracts/schemas/session':                 path.join(baseContracts, 'schemas', 'session.schemas'),
  '@contracts/schemas/provider':                path.join(baseContracts, 'schemas', 'provider.schemas'),
  '@contracts/schemas/orchestration':           path.join(baseContracts, 'schemas', 'orchestration.schemas'),
  '@contracts/schemas/settings':                path.join(baseContracts, 'schemas', 'settings.schemas'),
  '@contracts/schemas/file-operations':         path.join(baseContracts, 'schemas', 'file-operations.schemas'),
  '@contracts/schemas/security':                path.join(baseContracts, 'schemas', 'security.schemas'),
  '@contracts/schemas/observability':           path.join(baseContracts, 'schemas', 'observability.schemas'),
  '@contracts/schemas/workspace-tools':         path.join(baseContracts, 'schemas', 'workspace-tools.schemas'),
  '@contracts/schemas/knowledge':               path.join(baseContracts, 'schemas', 'knowledge.schemas'),
  '@contracts/schemas/remote-node':             path.join(baseContracts, 'schemas', 'remote-node.schemas'),
  '@contracts/schemas/plugin':                  path.join(baseContracts, 'schemas', 'plugin.schemas'),
  '@contracts/schemas/image':                   path.join(baseContracts, 'schemas', 'image.schemas'),
  '@contracts/schemas/quota':                   path.join(baseContracts, 'schemas', 'quota.schemas'),
  '@contracts/schemas/provider-runtime-events': path.join(baseContracts, 'schemas', 'provider-runtime-events.schemas'),
  '@contracts/types/transport':                 path.join(baseContracts, 'types', 'transport.types'),
};

const prefixAliases: Record<string, string> = {
  '@contracts': baseContracts,
  '@sdk': baseSdk,
  '@shared': baseShared,
};

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const NativeModule = require('module') as any;

const originalResolveFilename: (...args: unknown[]) => string =
  NativeModule._resolveFilename.bind(NativeModule);

function resolveFilename(request: string, ...rest: unknown[]): string {
  const exactTarget = exactAliases[request];
  if (exactTarget !== undefined) {
    return originalResolveFilename(exactTarget, ...rest);
  }
  for (const [alias, target] of Object.entries(prefixAliases)) {
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
