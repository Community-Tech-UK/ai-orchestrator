/**
 * WS3 (loop-convergence plan) — transition-based ledger convergence.
 *
 * The old historical-minimum tracker read "raw open count never reaches a new
 * low" as a stall, which false-killed loops that resolved distinct leaves while
 * discovering new ones at the same rate. These tests pin the new semantics:
 * known-leaf transitions are progress; discoveries, churn, regressions, and
 * repeated evidence are not.
 */

import { describe, expect, it } from 'vitest';
import type { LedgerConvergenceState } from '../../shared/types/loop-state.types';
import {
  computeObjectiveEvidenceKey,
  DEFAULT_MAX_LEDGER_STALL_ITERATIONS,
  isLedgerConvergenceStalled,
  unresolvedKnownTaskIds,
  updateLedgerConvergence,
} from './loop-ledger-progress';
import { parseTaskLedger } from './loop-task-ledger';

function ledgerOf(lines: string[]): ReturnType<typeof parseTaskLedger> {
  return parseTaskLedger(lines.join('\n'));
}

function advance(
  tracker: LedgerConvergenceState | undefined,
  lines: string[],
  evidenceKey: string | null = null,
): { next: LedgerConvergenceState; meaningfulTransition: boolean; warnings: string[] } {
  const update = updateLedgerConvergence(tracker, ledgerOf(lines), evidenceKey);
  if (!update) throw new Error('expected a tracker update');
  return update;
}

describe('updateLedgerConvergence — initialization and migration', () => {
  it('returns null for an empty ledger with no prior tracker (never initializes empty)', () => {
    expect(updateLedgerConvergence(undefined, parseTaskLedger(''), null)).toBeNull();
  });

  it('freezes plannedLeafIds on the first non-empty snapshot', () => {
    const { next, meaningfulTransition } = advance(undefined, [
      '- [ ] one <!-- loop-task-id:a -->',
      '- [x] two <!-- loop-task-id:b -->',
    ]);
    expect(next.plannedLeafIds.sort()).toEqual(['a', 'b']);
    expect(next.discoveredLeafIds).toEqual([]);
    expect(next.knownTaskStates).toEqual({ a: 'todo', b: 'done' });
    expect(next.noMeaningfulTransitionIterations).toBe(0);
    expect(meaningfulTransition).toBe(true);
  });

  it('migrates an old checkpoint (legacy count fields only) by initializing fresh', () => {
    // An old checkpoint has ledgerOpenCountBest/ledgerNoImprovementIterations
    // but no tracker — the first new snapshot initializes with a fresh counter
    // (the legacy counter measured a different, false-stall-prone quantity).
    const { next } = advance(undefined, ['- [ ] carried over <!-- loop-task-id:x -->']);
    expect(next.version).toBe(1);
    expect(next.noMeaningfulTransitionIterations).toBe(0);
  });
});

describe('updateLedgerConvergence — meaningful transitions', () => {
  const START = ['- [ ] alpha <!-- loop-task-id:alpha -->', '- [ ] beta <!-- loop-task-id:beta -->'];

  it('REGRESSION (incident): a raw open count that rises while distinct leaves resolve never stalls', () => {
    // Iteration 0: 4 open planned leaves.
    let tracker = advance(undefined, [
      '- [ ] ws2 <!-- loop-task-id:ws2 -->',
      '- [ ] ws3 <!-- loop-task-id:ws3 -->',
      '- [ ] ws4 <!-- loop-task-id:ws4 -->',
      '- [ ] ws5 <!-- loop-task-id:ws5 -->',
    ]).next;
    // Each iteration closes one known leaf AND discovers one new task, so the
    // raw open count stays 4 forever (the old tracker called this a stall).
    const rounds: [string, string][] = [['ws2', 'd1'], ['ws3', 'd2'], ['ws4', 'd3'], ['ws5', 'd4']];
    const closed = new Set<string>();
    const discovered: string[] = [];
    for (const [closeId, discoverId] of rounds) {
      closed.add(closeId);
      discovered.push(discoverId);
      const lines = [
        ...['ws2', 'ws3', 'ws4', 'ws5'].map((id) => `- [${closed.has(id) ? 'x' : ' '}] ${id} <!-- loop-task-id:${id} -->`),
        ...discovered.map((id) => `- [ ] ${id} <!-- loop-task-id:${id} -->`),
      ];
      const update = advance(tracker, lines);
      expect(update.meaningfulTransition).toBe(true);
      expect(update.next.noMeaningfulTransitionIterations).toBe(0);
      tracker = update.next;
    }
    expect(isLedgerConvergenceStalled(tracker, DEFAULT_MAX_LEDGER_STALL_ITERATIONS)).toBe(false);
    expect(tracker.discoveredLeafIds).toEqual(['d1', 'd2', 'd3', 'd4']);
    // The discoveries are still required work.
    expect(unresolvedKnownTaskIds(tracker).sort()).toEqual(['d1', 'd2', 'd3', 'd4']);
  });

  it('an unchanged snapshot is not meaningful (counter advances)', () => {
    const init = advance(undefined, START).next;
    const update = advance(init, START);
    expect(update.meaningfulTransition).toBe(false);
    expect(update.next.noMeaningfulTransitionIterations).toBe(1);
  });

  it('todo → done and todo → validly-deferred are meaningful', () => {
    const init = advance(undefined, START).next;
    expect(advance(init, [
      '- [x] alpha <!-- loop-task-id:alpha -->',
      '- [ ] beta <!-- loop-task-id:beta -->',
    ]).meaningfulTransition).toBe(true);
    expect(advance(init, [
      '- [ ] alpha <!-- loop-task-id:alpha -->',
      '- [-] beta — deferred: out of scope <!-- loop-task-id:beta -->',
    ]).meaningfulTransition).toBe(true);
  });

  it('a deferral WITHOUT a reason is not meaningful and warns', () => {
    const init = advance(undefined, START).next;
    const update = advance(init, [
      '- [-] alpha <!-- loop-task-id:alpha -->',
      '- [ ] beta <!-- loop-task-id:beta -->',
    ]);
    expect(update.meaningfulTransition).toBe(false);
    expect(update.warnings.some((w) => w.includes('deferred without a reason'))).toBe(true);
  });

  it('todo → doing is meaningful exactly once per task', () => {
    const init = advance(undefined, START).next;
    const first = advance(init, [
      '- [~] alpha <!-- loop-task-id:alpha -->',
      '- [ ] beta <!-- loop-task-id:beta -->',
    ]);
    expect(first.meaningfulTransition).toBe(true);
    // Regress to todo, then flip to doing again: no second credit — the
    // recorded state never moved backward.
    const regressed = advance(first.next, START);
    expect(regressed.meaningfulTransition).toBe(false);
    const second = advance(regressed.next, [
      '- [~] alpha <!-- loop-task-id:alpha -->',
      '- [ ] beta <!-- loop-task-id:beta -->',
    ]);
    expect(second.meaningfulTransition).toBe(false);
  });

  it('a done → todo regression is not progress, stays visible, and keeps the counter advancing', () => {
    const init = advance(undefined, ['- [x] alpha <!-- loop-task-id:alpha -->', '- [ ] beta <!-- loop-task-id:beta -->']).next;
    const update = advance(init, START);
    expect(update.meaningfulTransition).toBe(false);
    expect(update.next.noMeaningfulTransitionIterations).toBe(1);
    expect(update.warnings.some((w) => w.includes('moved backward'))).toBe(true);
    // Recorded state keeps the max progress: re-closing alpha gives no new credit.
    expect(update.next.knownTaskStates['alpha']).toBe('done');
    const reclose = advance(update.next, ['- [x] alpha <!-- loop-task-id:alpha -->', '- [ ] beta <!-- loop-task-id:beta -->']);
    expect(reclose.meaningfulTransition).toBe(false);
  });

  it('deleting an unresolved task warns and keeps it required (removal is not completion)', () => {
    const init = advance(undefined, START).next;
    const update = advance(init, ['- [ ] beta <!-- loop-task-id:beta -->']);
    expect(update.meaningfulTransition).toBe(false);
    expect(update.warnings.some((w) => w.includes('removal is not completion'))).toBe(true);
    expect(unresolvedKnownTaskIds(update.next)).toContain('alpha');
  });

  it('refining a task into a parent with children drops it in favor of its leaves', () => {
    const init = advance(undefined, START).next;
    const update = advance(init, [
      '- [ ] alpha <!-- loop-task-id:alpha -->',
      '  - [ ] alpha part 1 <!-- loop-task-id:alpha.1 -->',
      '  - [ ] alpha part 2 <!-- loop-task-id:alpha.2 -->',
      '- [ ] beta <!-- loop-task-id:beta -->',
    ]);
    expect(update.warnings).toEqual([]);
    expect(unresolvedKnownTaskIds(update.next).sort()).toEqual(['alpha.1', 'alpha.2', 'beta']);
  });

  it('discovery without progress is not meaningful', () => {
    const init = advance(undefined, START).next;
    const update = advance(init, [...START, '- [ ] gamma <!-- loop-task-id:gamma -->']);
    expect(update.meaningfulTransition).toBe(false);
    expect(update.next.discoveredLeafIds).toEqual(['gamma']);
    expect(update.next.noMeaningfulTransitionIterations).toBe(1);
  });

  it('repairing a duplicate/malformed inventory is meaningful', () => {
    const init = advance(undefined, [
      '- [ ] one <!-- loop-task-id:dup -->',
      '- [ ] two <!-- loop-task-id:dup -->',
    ]).next;
    expect(init.inventoryInvalid).toBe(true);
    const repaired = advance(init, [
      '- [ ] one <!-- loop-task-id:one -->',
      '- [ ] two <!-- loop-task-id:two -->',
    ]);
    expect(repaired.meaningfulTransition).toBe(true);
    expect(repaired.next.inventoryInvalid).toBeUndefined();
  });
});

describe('updateLedgerConvergence — objective evidence', () => {
  const START = ['- [ ] alpha <!-- loop-task-id:alpha -->'];

  it('a NEW evidence key is meaningful; repeating the same key is not', () => {
    const init = advance(undefined, START).next;
    const first = advance(init, START, 'verify-pass:run-1');
    expect(first.meaningfulTransition).toBe(true);
    expect(first.next.lastObjectiveEvidenceKey).toBe('verify-pass:run-1');
    const repeat = advance(first.next, START, 'verify-pass:run-1');
    expect(repeat.meaningfulTransition).toBe(false);
    const fresh = advance(repeat.next, START, 'verify-pass:run-2');
    expect(fresh.meaningfulTransition).toBe(true);
  });
});

describe('computeObjectiveEvidenceKey', () => {
  it('prefers the newest passing verification run', () => {
    expect(computeObjectiveEvidenceKey({
      verificationRuns: [
        { id: 'r1', exitCode: 0, startedAt: 10 },
        { id: 'r2', exitCode: 1, startedAt: 20 },
        { id: 'r3', exitCode: 0, startedAt: 15 },
      ],
      testPassCount: 5,
      previousHighestTestPassCount: 2,
    })).toBe('verify-pass:r3');
  });

  it('falls back to a strictly higher test-pass count', () => {
    expect(computeObjectiveEvidenceKey({
      verificationRuns: [{ id: 'r1', exitCode: 1, startedAt: 10 }],
      testPassCount: 7,
      previousHighestTestPassCount: 5,
    })).toBe('tests:7');
    expect(computeObjectiveEvidenceKey({
      verificationRuns: [],
      testPassCount: 5,
      previousHighestTestPassCount: 5,
    })).toBeNull();
    expect(computeObjectiveEvidenceKey({
      verificationRuns: [],
      testPassCount: null,
      previousHighestTestPassCount: 0,
    })).toBeNull();
  });
});

describe('isLedgerConvergenceStalled', () => {
  const START = ['- [ ] alpha <!-- loop-task-id:alpha -->', '- [x] beta <!-- loop-task-id:beta -->'];

  it('stalls only after `limit` consecutive non-meaningful iterations with open work', () => {
    let tracker = advance(undefined, START).next;
    for (let i = 0; i < 3; i++) {
      expect(isLedgerConvergenceStalled(tracker, 3)).toBe(false);
      tracker = advance(tracker, START).next;
    }
    expect(tracker.noMeaningfulTransitionIterations).toBe(3);
    expect(isLedgerConvergenceStalled(tracker, 3)).toBe(true);
  });

  it('a fully resolved inventory is never a stall', () => {
    let tracker = advance(undefined, ['- [x] alpha <!-- loop-task-id:alpha -->']).next;
    for (let i = 0; i < 5; i++) tracker = advance(tracker, ['- [x] alpha <!-- loop-task-id:alpha -->']).next;
    expect(isLedgerConvergenceStalled(tracker, 3)).toBe(false);
  });

  it('no tracker (no ledger yet) is never a stall', () => {
    expect(isLedgerConvergenceStalled(undefined, 3)).toBe(false);
  });
});
