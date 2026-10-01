import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import { revealHiddenAutomationSession, stampHiddenAutomationOutcome } from './automation-hidden-outcome';

function makeManager(metadata?: Record<string, unknown>) {
  const instance = { id: 'i1', metadata } as unknown as Instance;
  return {
    instance,
    manager: {
      getInstance: vi.fn((id: string) => (id === 'i1' ? instance : undefined)),
      queueInstanceUpdate: vi.fn(),
    },
  };
}

describe('revealHiddenAutomationSession', () => {
  it('stamps a hidden session and re-broadcasts so the renderer learns it', () => {
    const { instance, manager } = makeManager({ automationHidden: true });

    revealHiddenAutomationSession(manager, 'i1');

    expect(instance.metadata?.['automationRevealed']).toBe(true);
    expect(manager.queueInstanceUpdate).toHaveBeenCalledWith('i1', {});
  });

  it('is idempotent, so repeated operator sends do not re-broadcast', () => {
    const { manager } = makeManager({ automationHidden: true });

    revealHiddenAutomationSession(manager, 'i1');
    revealHiddenAutomationSession(manager, 'i1');

    expect(manager.queueInstanceUpdate).toHaveBeenCalledTimes(1);
  });

  it('leaves ordinary sessions and missing instances alone', () => {
    const { instance, manager } = makeManager({ automationId: 'a1' });

    revealHiddenAutomationSession(manager, 'i1');
    revealHiddenAutomationSession(manager, 'gone');
    revealHiddenAutomationSession(null, 'i1');

    expect(instance.metadata?.['automationRevealed']).toBeUndefined();
    expect(manager.queueInstanceUpdate).not.toHaveBeenCalled();
  });

  it('still stamps when the source cannot re-broadcast (the mobile gateway type)', () => {
    const { instance, manager } = makeManager({ automationHidden: true });

    revealHiddenAutomationSession({ getInstance: manager.getInstance }, 'i1');

    expect(instance.metadata?.['automationRevealed']).toBe(true);
  });
});

describe('stampHiddenAutomationOutcome', () => {
  it('marks a clean finish as safe to hide on archive, without revealing it', () => {
    const { instance, manager } = makeManager({ automationHidden: true });

    stampHiddenAutomationOutcome(manager, 'i1', 'succeeded');

    expect(instance.metadata?.['automationRunSucceeded']).toBe(true);
    expect(instance.metadata?.['automationRevealed']).toBeUndefined();
    expect(manager.queueInstanceUpdate).not.toHaveBeenCalled();
  });

  it('reveals every other ending', () => {
    for (const status of ['failed', 'cancelled', 'skipped'] as const) {
      const { instance, manager } = makeManager({ automationHidden: true });

      stampHiddenAutomationOutcome(manager, 'i1', status);

      expect(instance.metadata?.['automationRunSucceeded'], status).toBeUndefined();
      expect(instance.metadata?.['automationRevealed'], status).toBe(true);
    }
  });
});
