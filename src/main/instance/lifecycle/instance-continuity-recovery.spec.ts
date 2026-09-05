import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../../shared/types/instance.types';
import type { PendingEnvelope } from '../../providers/provider-runtime-event-bus';
import { InstanceContinuityRecovery } from './instance-continuity-recovery';

describe('InstanceContinuityRecovery provider-event redaction', () => {
  it('preserves the typed completion freshness fence while removing raw recovery data', () => {
    const instance = {
      id: 'recovered-instance',
      metadata: { reason: 'crash-recovery', continuityRevival: true },
    } as unknown as Instance;
    const recovery = new InstanceContinuityRecovery({
      createInstance: vi.fn(),
      createUnpublishedInstance: vi.fn(),
      getAllInstances: vi.fn(() => [instance]),
      getInstance: vi.fn(() => instance),
      queueContinuityPreamble: vi.fn(),
      clearCommunication: vi.fn(),
      clearPendingState: vi.fn(),
      removeProviderEvents: vi.fn(),
      clearSettledState: vi.fn(),
    });
    const pending: PendingEnvelope = {
      timestamp: 1,
      provider: 'claude',
      instanceId: instance.id,
      sessionId: 'sensitive-recovery-session',
      raw: {
        source: 'adapter-event:complete',
        payload: { sessionId: 'sensitive-recovery-session' },
      },
      event: {
        kind: 'complete',
        requestCountAtCompletion: 7,
      },
    };

    const redacted = recovery.redactProviderEnvelope(pending);

    expect(redacted).not.toHaveProperty('sessionId');
    expect(redacted).not.toHaveProperty('raw');
    expect(redacted.event).toEqual({
      kind: 'complete',
      requestCountAtCompletion: 7,
    });
  });
});
