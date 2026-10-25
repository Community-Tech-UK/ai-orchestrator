import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';

const continuity = vi.hoisted(() => ({ updateState: vi.fn(async () => undefined) }));
vi.mock('../session/session-continuity', () => ({
  getSessionContinuityManagerIfInitialized: () => continuity,
}));

import { releaseAutomationOwnership, revealHiddenAutomationSession, stampHiddenAutomationOutcome } from './automation-hidden-outcome';

beforeEach(() => continuity.updateState.mockClear());

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

describe('automation outcome persistence', () => {
  it('mirrors a clean finish into the autosave so a crash-recovered run is filed hidden', () => {
    const { manager } = makeManager({ automationId: 'a1', automationHidden: true });

    stampHiddenAutomationOutcome(manager, 'i1', 'succeeded');

    expect(continuity.updateState).toHaveBeenCalledWith('i1', {
      automation: { automationId: 'a1', hidden: true, runSucceeded: true },
    });
  });

  it('mirrors a takeover into the autosave so a crash-recovered run stays visible', () => {
    const { manager } = makeManager({ automationId: 'a1', automationHidden: true, automationRunSucceeded: true });

    revealHiddenAutomationSession(manager, 'i1');

    expect(continuity.updateState).toHaveBeenCalledWith('i1', {
      automation: { automationId: 'a1', hidden: true, runSucceeded: true, revealed: true },
    });
  });

  it('writes nothing for visible automations or ordinary sessions', () => {
    const visible = makeManager({ automationId: 'a1' });
    stampHiddenAutomationOutcome(visible.manager, 'i1', 'succeeded');
    revealHiddenAutomationSession(visible.manager, 'i1');

    expect(continuity.updateState).not.toHaveBeenCalled();
  });
});

describe('manual automation ownership transfer', () => {
  it('clears only the matching active marker and persists its historical source', () => {
    const { instance,manager }=makeManager({automationId:'a1',automationRunId:'run-1',automationHidden:true,repoJobId:'other-engine'});
    releaseAutomationOwnership(manager,'i1','run-1');
    expect(instance.metadata).toEqual({automationId:'a1',automationSourceRunId:'run-1',automationHidden:true,automationRevealed:true,repoJobId:'other-engine'});
    expect(continuity.updateState).toHaveBeenCalledWith('i1',{automation:{automationId:'a1',automationSourceRunId:'run-1',hidden:true,revealed:true}});
    expect(manager.queueInstanceUpdate).toHaveBeenCalledTimes(1);
    releaseAutomationOwnership(manager,'i1','run-1');
    expect(manager.queueInstanceUpdate).toHaveBeenCalledTimes(1);
  });
  it('leaves a different run and unrelated engine ownership untouched', () => {
    const { instance,manager }=makeManager({automationId:'a1',automationRunId:'run-2',planQueueRole:'worker'});
    releaseAutomationOwnership(manager,'i1','run-1');
    expect(instance.metadata).toEqual({automationId:'a1',automationRunId:'run-2',planQueueRole:'worker'});
    expect(continuity.updateState).not.toHaveBeenCalled();expect(manager.queueInstanceUpdate).not.toHaveBeenCalled();
  });
});
