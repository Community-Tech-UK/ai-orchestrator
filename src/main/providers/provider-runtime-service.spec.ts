import { describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { ProviderRuntimeService } from './provider-runtime-service';

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
});
