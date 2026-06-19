import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SessionTurnSupervisor,
  getOrCreateTurnSupervisor,
  getTurnSupervisor,
  deleteTurnSupervisor,
  _resetTurnSupervisorsForTesting,
} from './session-turn-supervisor';

// Suppress the turn journal writes (session-continuity not initialized in tests).
vi.mock('./session-continuity', () => ({
  getSessionContinuityManagerIfInitialized: () => undefined,
}));

describe('SessionTurnSupervisor', () => {
  let supervisor: SessionTurnSupervisor;

  beforeEach(() => {
    supervisor = new SessionTurnSupervisor('inst-1');
  });

  describe('interrupt sequence', () => {
    it('starts at seq 0', () => {
      expect(supervisor.snapshot().interruptSeq).toBe(0);
    });

    it('recordInterrupt() increments and returns the new seq', () => {
      expect(supervisor.recordInterrupt()).toBe(1);
      expect(supervisor.recordInterrupt()).toBe(2);
      expect(supervisor.snapshot().interruptSeq).toBe(2);
    });

    it('isInterruptSeqCurrent() returns true for the latest seq', () => {
      const seq = supervisor.recordInterrupt();
      expect(supervisor.isInterruptSeqCurrent(seq)).toBe(true);
    });

    it('isInterruptSeqCurrent() returns false when a newer interrupt fires', () => {
      const captured = supervisor.recordInterrupt();
      supervisor.recordInterrupt(); // second interrupt
      expect(supervisor.isInterruptSeqCurrent(captured)).toBe(false);
    });
  });

  describe('turn lifecycle', () => {
    it('recordTurnStart() increments turnGeneration and sets activeOperation=turn', () => {
      supervisor.recordTurnStart('turn-1');
      expect(supervisor.snapshot().turnGeneration).toBe(1);
      expect(supervisor.snapshot().activeOperation).toBe('turn');
    });

    it('recordTurnEnd() sets activeOperation=idle', () => {
      supervisor.recordTurnStart('turn-1');
      supervisor.recordTurnEnd('completed');
      expect(supervisor.snapshot().activeOperation).toBe('idle');
    });

    it('multiple turns increment turnGeneration each time', () => {
      supervisor.recordTurnStart();
      supervisor.recordTurnEnd('completed');
      supervisor.recordTurnStart();
      expect(supervisor.snapshot().turnGeneration).toBe(2);
    });
  });

  describe('adapter setup', () => {
    it('recordAdapterSetup() mirrors adapterGeneration and sets activeOperation=idle', () => {
      supervisor.recordAdapterSetup(5);
      expect(supervisor.snapshot().adapterGeneration).toBe(5);
      expect(supervisor.snapshot().activeOperation).toBe('idle');
    });
  });

  describe('respawn', () => {
    it('recordRespawn() updates restartEpoch and adapterGeneration', () => {
      supervisor.recordRespawn(3, 7);
      const snap = supervisor.snapshot();
      expect(snap.restartEpoch).toBe(3);
      expect(snap.adapterGeneration).toBe(7);
      expect(snap.activeOperation).toBe('idle');
    });
  });

  describe('snapshot', () => {
    it('includes instanceId', () => {
      expect(supervisor.snapshot().instanceId).toBe('inst-1');
    });
  });
});

describe('session-turn-supervisor registry', () => {
  beforeEach(() => {
    _resetTurnSupervisorsForTesting();
  });

  it('getOrCreateTurnSupervisor returns the same instance', () => {
    const a = getOrCreateTurnSupervisor('inst-1');
    const b = getOrCreateTurnSupervisor('inst-1');
    expect(a).toBe(b);
  });

  it('getTurnSupervisor returns undefined for unknown instance', () => {
    expect(getTurnSupervisor('unknown')).toBeUndefined();
  });

  it('getTurnSupervisor finds an existing supervisor', () => {
    const created = getOrCreateTurnSupervisor('inst-2');
    expect(getTurnSupervisor('inst-2')).toBe(created);
  });

  it('deleteTurnSupervisor removes the entry', () => {
    getOrCreateTurnSupervisor('inst-3');
    deleteTurnSupervisor('inst-3');
    expect(getTurnSupervisor('inst-3')).toBeUndefined();
  });

  it('different instance IDs are independent', () => {
    const a = getOrCreateTurnSupervisor('inst-A');
    const b = getOrCreateTurnSupervisor('inst-B');
    a.recordInterrupt();
    expect(b.snapshot().interruptSeq).toBe(0);
  });
});
