import { describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { AdapterRuntimeCapabilities } from '../cli/adapters/base-cli-adapter';
import { ProviderRuntimeRegistry } from './provider-runtime-registry';
import { ProviderRuntimeService } from './provider-runtime-service';

const resumableCapabilities: AdapterRuntimeCapabilities = {
  supportsResume: true,
  supportsForkSession: false,
  supportsNativeCompaction: true,
  supportsPermissionPrompts: false,
  supportsDeferPermission: false,
  selfManagedAutoCompaction: true,
};

describe('ProviderRuntimeService runtime snapshots', () => {
  it('reads provider identity through one adapter snapshot call', () => {
    const snapshot = {
      revision: 7,
      capturedAt: 123,
      providerSessionId: 'thread-7',
      nativeThreadId: 'thread-7',
      activeTurnId: 'turn-2',
    };
    const getRuntimeSnapshot = vi.fn(() => snapshot);
    const adapter = { getRuntimeSnapshot } as unknown as CliAdapter;

    const service = new ProviderRuntimeService({
      createAdapter: () => adapter,
    });

    expect(service.getRuntimeSnapshot(adapter)).toBe(snapshot);
    expect(getRuntimeSnapshot).toHaveBeenCalledTimes(1);
  });

  it('uses the provider registry when the live adapter has been disposed', () => {
    const registry = new ProviderRuntimeRegistry();
    registry.recordAvailable({
      provider: 'codex',
      capabilities: resumableCapabilities,
    });
    const service = new ProviderRuntimeService({
      registry,
      createAdapter: () => { throw new Error('unused'); },
    });

    expect(service.getCapabilities(undefined, 'codex')).toEqual(resumableCapabilities);
  });

  it('keeps capability lookup conservative without an adapter or registry snapshot', () => {
    const service = new ProviderRuntimeService({
      registry: new ProviderRuntimeRegistry(),
      createAdapter: () => { throw new Error('unused'); },
    });

    expect(service.getCapabilities(undefined, 'codex')).toMatchObject({
      supportsResume: false,
      supportsForkSession: false,
    });
  });

  it('prefers live adapter capabilities over a stale registry snapshot', () => {
    const registry = new ProviderRuntimeRegistry();
    registry.recordAvailable({ provider: 'codex', capabilities: resumableCapabilities });
    const liveCapabilities = { ...resumableCapabilities, supportsResume: false };
    const adapter = {
      getRuntimeCapabilities: () => liveCapabilities,
    } as unknown as CliAdapter;
    const service = new ProviderRuntimeService({
      registry,
      createAdapter: () => adapter,
    });

    expect(service.getCapabilities(adapter, 'codex')).toEqual(liveCapabilities);
  });
});
