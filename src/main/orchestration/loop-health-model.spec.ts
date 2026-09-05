import { describe, expect, it } from 'vitest';
import {
  ALIVE_OBSERVATION_TTL_MS,
  assessLoopHealth,
  STALL_WINDOW_MS,
  type LoopHealthProbes,
} from './loop-health-model';

const NOW = 1_000_000;

function probes(over: Partial<LoopHealthProbes> = {}): LoopHealthProbes {
  return {
    processAliveAt: NOW - 1_000,
    lastActivityAt: NOW - 1_000,
    turnStartedAt: NOW - 30_000,
    phase: null,
    subprocessAlive: false,
    now: NOW,
    ...over,
  };
}

describe('assessLoopHealth (L3)', () => {
  it('reports advancing when the child is producing observable work', () => {
    const health = assessLoopHealth(probes());

    expect(health.state).toBe('advancing');
    expect(health.holdStallCounters).toBe(false);
  });

  it('names the inferred phase in the advancing reason', () => {
    expect(assessLoopHealth(probes({ phase: 'editing' })).reason).toBe('advancing (editing)');
  });

  // Rule 1. This is the single most important behaviour in the module: an
  // unanswerable probe is not a death certificate.
  it('holds on unknown rather than concluding death when the process probe cannot answer', () => {
    const health = assessLoopHealth(probes({ processAliveAt: null }));

    expect(health.state).toBe('unknown');
    expect(health.holdStallCounters).toBe(true);
    expect(health.reason).toContain('could not answer');
  });

  it('reports zombie only when the process is positively absent', () => {
    const health = assessLoopHealth(probes({ processAliveAt: undefined }));

    expect(health.state).toBe('zombie');
    expect(health.holdStallCounters).toBe(false);
  });

  // Rule 2: knowing a process existed a while ago is not knowing it exists now.
  it('decays a stale liveness observation back to unknown', () => {
    const health = assessLoopHealth(probes({
      processAliveAt: NOW - ALIVE_OBSERVATION_TTL_MS - 1,
    }));

    expect(health.state).toBe('unknown');
    expect(health.holdStallCounters).toBe(true);
  });

  // Rule 3: a ten-minute test run must not read as a wedged child.
  it('holds stall counters while a spawned subprocess is running', () => {
    const health = assessLoopHealth(probes({
      subprocessAlive: true,
      lastActivityAt: NOW - STALL_WINDOW_MS - 60_000,
    }));

    expect(health.state).toBe('waiting-on-build');
    expect(health.holdStallCounters).toBe(true);
  });

  it('holds stall counters while the inferred phase says checks are running', () => {
    const health = assessLoopHealth(probes({
      phase: 'verifying',
      lastActivityAt: NOW - STALL_WINDOW_MS - 60_000,
    }));

    expect(health.state).toBe('waiting-on-build');
    expect(health.holdStallCounters).toBe(true);
  });

  it('treats a turn with no activity yet as starting, not stuck', () => {
    const health = assessLoopHealth(probes({ lastActivityAt: null, turnStartedAt: NOW - 5_000 }));

    expect(health.state).toBe('waiting-first-token');
    expect(health.holdStallCounters).toBe(true);
  });

  it('eventually calls a silent turn stalled once the window is past', () => {
    const health = assessLoopHealth(probes({
      lastActivityAt: null,
      turnStartedAt: NOW - STALL_WINDOW_MS - 1_000,
    }));

    expect(health.state).toBe('stalled');
    expect(health.holdStallCounters).toBe(false);
  });

  it('reports stalled for a live process that stopped doing anything', () => {
    const health = assessLoopHealth(probes({ lastActivityAt: NOW - STALL_WINDOW_MS - 1 }));

    expect(health.state).toBe('stalled');
    expect(health.reason).toContain('no tool call or command');
  });

  // An unknown process probe must win over every other signal, including a
  // subprocess that looks alive — the whole pass is untrustworthy.
  it('prefers unknown over waiting-on-build when the process probe failed', () => {
    const health = assessLoopHealth(probes({ processAliveAt: null, subprocessAlive: true }));

    expect(health.state).toBe('unknown');
  });
});
