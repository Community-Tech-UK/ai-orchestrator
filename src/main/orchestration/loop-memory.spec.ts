/**
 * LF-6 (loopfixex.md) — cross-loop memory: distill, render, and the in-memory
 * store (record in "run 1" → surface in "run 2", keyed by workspace).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DurableLoopMemoryStore,
  InMemoryLoopMemoryStore,
  distillLearning,
  loopStatusToOutcome,
  renderLearningLine,
} from './loop-memory';

describe('distillLearning', () => {
  it('captures outcome, dead-ends, and deferred items as observations', () => {
    const rec = distillLearning({
      workspaceCwd: '/ws',
      goal: 'implement the parser',
      status: 'cap-reached',
      reason: 'stopped while the last verify was FAILING',
      lastCompletionOutcome: 'verify-failed',
      deadEnds: ['kept retrying the same broken regex'],
      deferredItems: ['cross-model fan-out'],
    });
    expect(rec.observations).toContain('last completion outcome: verify-failed');
    expect(rec.observations).toContain('dead-end: kept retrying the same broken regex');
    expect(rec.observations).toContain('deferred: cross-model fan-out');
  });
});

describe('renderLearningLine', () => {
  it('renders a bounded one-liner with goal, reason, and observations', () => {
    const line = renderLearningLine({
      workspaceCwd: '/ws', goal: 'g', status: 'no-progress',
      reason: 'identical work hash', observations: ['dead-end: X', 'deferred: Y'],
    });
    expect(line).toContain('[no-progress]');
    expect(line).toContain('identical work hash');
    expect(line).toContain('dead-end: X');
  });
  it('truncates very long lines', () => {
    const line = renderLearningLine({
      workspaceCwd: '/ws', goal: 'x'.repeat(500), status: 's', reason: 'y'.repeat(500), observations: [],
    });
    expect(line.length).toBeLessThanOrEqual(300);
  });
});

describe('InMemoryLoopMemoryStore', () => {
  it('records a learning in one run and surfaces it in the next (same workspace)', () => {
    const store = new InMemoryLoopMemoryStore();
    // run 1
    store.recordLearning(distillLearning({
      workspaceCwd: '/proj/app', goal: 'do the thing', status: 'cap-reached',
      reason: 'verify kept failing', deadEnds: ['broken regex'],
    }));
    // run 2 — same workspace
    const surfaced = store.surfaceLearnings('/proj/app', 3);
    expect(surfaced.length).toBe(1);
    expect(surfaced[0]).toContain('verify kept failing');
    expect(surfaced[0]).toContain('dead-end: broken regex');
  });

  it('does not leak learnings across unrelated workspaces', () => {
    const store = new InMemoryLoopMemoryStore();
    store.recordLearning(distillLearning({ workspaceCwd: '/proj/a', goal: 'g', status: 's', reason: 'r' }));
    expect(store.surfaceLearnings('/proj/b', 3)).toEqual([]);
  });

  it('surfaces newest-first and honours the limit', () => {
    const store = new InMemoryLoopMemoryStore();
    for (let i = 0; i < 5; i++) {
      store.recordLearning(distillLearning({ workspaceCwd: '/p', goal: `goal ${i}`, status: 's', reason: `reason ${i}` }));
    }
    const surfaced = store.surfaceLearnings('/p', 2);
    expect(surfaced.length).toBe(2);
    expect(surfaced[0]).toContain('reason 4'); // newest first
    expect(surfaced[1]).toContain('reason 3');
  });
});

describe('loopStatusToOutcome', () => {
  it('maps statuses to coarse episodic outcomes', () => {
    expect(loopStatusToOutcome('completed')).toBe('success');
    expect(loopStatusToOutcome('failed')).toBe('failure');
    expect(loopStatusToOutcome('error')).toBe('failure');
    expect(loopStatusToOutcome('cancelled')).toBe('failure');
    expect(loopStatusToOutcome('cost-exceeded')).toBe('failure');
    expect(loopStatusToOutcome('needs-human-arbitration')).toBe('failure');
    expect(loopStatusToOutcome('reviewer-unreliable')).toBe('failure');
    expect(loopStatusToOutcome('reviewer-unavailable')).toBe('failure');
    expect(loopStatusToOutcome('builder-unreliable')).toBe('failure');
    expect(loopStatusToOutcome('completed-needs-review')).toBe('partial');
    expect(loopStatusToOutcome('no-progress')).toBe('partial');
    expect(loopStatusToOutcome('cap-reached')).toBe('partial');
  });

  it('maps ended provider-limit loops to failure and resumable ones to partial', () => {
    expect(loopStatusToOutcome('provider-limit', 1_778_313_000_000)).toBe('failure');
    expect(loopStatusToOutcome('provider-limit', null)).toBe('partial');
  });
});

describe('DurableLoopMemoryStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loop-durable-'));
    filePath = join(dir, 'nested', 'loop-learnings.json'); // exercises mkdir
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('persists learnings to disk and surfaces them from a FRESH instance (cross-restart)', () => {
    const writer = new DurableLoopMemoryStore(filePath, { mirrorToEpisodic: false });
    writer.recordLearning(distillLearning({
      workspaceCwd: '/proj/app', goal: 'do the thing', status: 'cap-reached',
      reason: 'verify kept failing', deadEnds: ['broken regex'],
    }));

    // Simulate an app restart: a brand-new store instance reads the same file.
    const reader = new DurableLoopMemoryStore(filePath, { mirrorToEpisodic: false });
    const surfaced = reader.surfaceLearnings('/proj/app', 3);
    expect(surfaced.length).toBe(1);
    expect(surfaced[0]).toContain('verify kept failing');
    expect(surfaced[0]).toContain('dead-end: broken regex');
  });

  it('keys by workspace and bounds per-key history', () => {
    const store = new DurableLoopMemoryStore(filePath, { mirrorToEpisodic: false, maxPerKey: 3 });
    for (let i = 0; i < 5; i++) {
      store.recordLearning(distillLearning({ workspaceCwd: '/a', goal: `g${i}`, status: 's', reason: `r${i}` }));
    }
    store.recordLearning(distillLearning({ workspaceCwd: '/b', goal: 'gb', status: 's', reason: 'rb' }));

    const a = store.surfaceLearnings('/a', 10);
    expect(a.length).toBe(3); // bounded to maxPerKey
    expect(a[0]).toContain('r4'); // newest first
    expect(store.surfaceLearnings('/b', 10).length).toBe(1); // isolated per workspace
    expect(store.surfaceLearnings('/c', 10)).toEqual([]); // unknown workspace
  });

  it('returns [] and never throws when the file is absent or corrupt', () => {
    const store = new DurableLoopMemoryStore(filePath, { mirrorToEpisodic: false });
    expect(store.surfaceLearnings('/x', 3)).toEqual([]); // absent
    // corrupt the file, then read
    rmSync(dir, { recursive: true, force: true });
    expect(store.surfaceLearnings('/x', 3)).toEqual([]);
  });
});
