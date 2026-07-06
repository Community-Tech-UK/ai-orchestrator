/**
 * Verifies that InstanceManager.resolveProviderName routes the 'antigravity'
 * instanceProvider to the 'antigravity' ProviderName so that provider runtime
 * envelopes for Antigravity-backed instances reach the renderer instead of
 * being dropped by the unsupported-provider fallback.
 *
 * Regression: before this case was added, sending a message to an Antigravity
 * instance ran `agy` successfully but every output/status/complete envelope
 * was dropped ("Unsupported provider for runtime envelope"), so the UI showed
 * no response, no error, and no warning. Same failure mode previously hit
 * 'cursor' (see instance-manager-resolve-provider-cursor.spec.ts).
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

describe('InstanceManager.resolveProviderName - antigravity', () => {
  it('returns antigravity when instanceProvider = antigravity (implicit)', () => {
    const fn = getResolver();
    expect(fn.call({}, 'test-instance-id', undefined, 'antigravity')).toBe('antigravity');
  });

  it('returns antigravity when explicitProvider = antigravity', () => {
    const fn = getResolver();
    expect(fn.call({}, 'test-instance-id', 'antigravity', undefined)).toBe('antigravity');
  });
});
