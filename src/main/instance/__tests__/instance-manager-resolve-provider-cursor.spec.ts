/**
 * Verifies that InstanceManager.resolveProviderName routes the 'cursor'
 * instanceProvider to the 'cursor' ProviderName so that provider runtime
 * envelopes for Cursor-backed instances reach the renderer instead of being
 * dropped by the unsupported-provider fallback.
 *
 * resolveProviderName is a pure private method that does not read any
 * `this` state (it only touches the module-level logger), so we invoke it
 * directly off the prototype with a plain object as the `this` arg. This
 * avoids having to construct an InstanceManager (which pulls in the rest
 * of the main-process singletons).
 *
 * We still mock electron-store because InstanceManager's transitive imports
 * (command-manager, etc.) instantiate a store at module load.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/test-userData'),
    isPackaged: false,
  },
}));

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({
    store: {},
    get: vi.fn(),
    set: vi.fn(),
    clear: vi.fn(),
  })),
}));

// Import after mocks so the top-level `new ElectronStore(...)` in
// transitive imports hits the stub instead of the real implementation.
import { InstanceManager } from '../instance-manager';

type ResolveProviderName = (
  this: unknown,
  instanceId: string,
  explicitProvider: string | undefined,
  instanceProvider: string | undefined,
) => string | null;

function getResolver(): ResolveProviderName {
  const fn = (InstanceManager.prototype as unknown as {
    resolveProviderName: ResolveProviderName;
  }).resolveProviderName;
  return fn;
}

describe('InstanceManager.resolveProviderName - cursor', () => {
  it('returns cursor when instanceProvider = cursor (implicit)', () => {
    const fn = getResolver();
    expect(fn.call({}, 'test-instance-id', undefined, 'cursor')).toBe('cursor');
  });

  it('returns cursor when explicitProvider = cursor', () => {
    const fn = getResolver();
    expect(fn.call({}, 'test-instance-id', 'cursor', undefined)).toBe('cursor');
  });
});
