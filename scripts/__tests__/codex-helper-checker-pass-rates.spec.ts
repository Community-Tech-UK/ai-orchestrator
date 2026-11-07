import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { summarizeCheckerPassRates } from '../codex-helper-checker-pass-rates';
const key = (id: string) => createHash('sha256').update(id).digest('hex');
const policy = (id: string, level = 'off') => ({ provider: 'codex', sessionKind: 'plan-queue', applied: true, arm: level === 'off' ? 'candidate' : 'control', armKey: key(id), level });
it('joins hashed current keys and raw future keys without counting resumes twice', () => {
  const rows = summarizeCheckerPassRates([
    { id: 'passed', verdict_json: '{"verdict":"PASS"}' }, { id: 'failed', verdict_json: '{"verdict":"FAIL"}' },
    { id: 'unknown', verdict_json: null }, { id: 'full', verdict_json: '{"verdict":"PASS"}' },
  ], [policy('passed'), policy('passed'), policy('failed'), policy('unknown'), { ...policy('full', 'full'), armKey: 'full' }]);
  expect(rows.arms.off).toEqual({ passed: 1, failed: 1, unknown: 1, passRate: 0.5 });
  expect(rows.arms.full).toEqual({ passed: 1, failed: 0, unknown: 0, passRate: 1 });
});
it('excludes mixed or unapplied exposures and never treats a missing verdict as a pass', () => {
  const rows = summarizeCheckerPassRates([{ id: 'mixed', verdict_json: '{"verdict":"PASS"}' }, { id: 'bad', verdict_json: 'invalid' }, { id: 'unapplied', verdict_json: '{"verdict":"PASS"}' }],
    [policy('mixed'), policy('mixed', 'full'), policy('bad'), { ...policy('unapplied'), applied: false }]);
  expect(rows.excludedMixed).toBe(1); expect(rows.unassigned).toBe(1);
  expect(rows.arms.off).toEqual({ passed: 0, failed: 0, unknown: 1, passRate: null });
});
it('counts helper exposure when only an unrelated tuning key was rejected', () => {
  const rows = summarizeCheckerPassRates([{ id: 'cap-rejected', verdict_json: '{"verdict":"PASS"}' }],
    [{ ...policy('cap-rejected'), applied: false, helperPolicyApplied: true, rejectedKeys: ['model_context_window'] }]);
  expect(rows.unassigned).toBe(0);
  expect(rows.arms.off.passed).toBe(1);
});

/** Phase-1 integration contract (24 Oct): fixtures mirror the rows the trial
 * report (`scripts/codex-helper-trial-report.mjs`) actually emits and reads — `parsePolicyLog` keeps `atMs`/
 * `legacyFormat` and never rewrites arms, `plan_queue_items` rows carry the
 * `verdict_json` blob `plan-queue-store.ts` writes, and the helper-trial rebuild
 * flipped which hash parity gets which arm name while the applied level stayed
 * the ground truth (live rows pair candidate↔off and control↔full). Bucketing
 * must therefore survive both writer eras through `level`, so the Phase B
 * wiring is one call on report-shaped rows. */
describe('Phase-1 trial-report contract', () => {
  const legacyRow = (id: string, arm: 'control' | 'candidate', level: 'full' | 'off') => ({
    at: 1792706366780, atMs: 1792706366780, legacyFormat: true, provider: 'codex', threadId: `legacy-${id}`,
    sessionKind: 'plan-queue', level, arm, armKey: key(id), outputLimit: 4000, postTurnCompactPercent: 60, applied: true,
  });
  const futureRow = (id: string, arm: 'off' | 'full', level: 'off' | 'full') => ({
    at: '2026-10-24T12:00:00.000Z', atMs: 1792852800000, legacyFormat: false, provider: 'codex', threadId: `future-${id}`,
    sessionKind: 'plan-queue', level, arm, armKey: id, armSource: 'item', outputLimit: 4000, postTurnCompactPercent: 60, applied: true,
  });
  const item = (id: string, verdict: 'PASS' | 'FAIL' | null, documentComplete = true) => ({
    id, state: 'landed', round: 1, created_at: 1792700000000, updated_at: 1792706366780,
    verdict_json: verdict ? JSON.stringify({ verdict, findings: [], gatesRun: [], documentComplete, needJames: [] }) : null,
  });

  it('takes parsePolicyLog and plan_queue_items rows verbatim from both writer eras', () => {
    const rows = summarizeCheckerPassRates(
      [item('legacy-off-item', 'PASS'), item('future-full-item', 'FAIL'), item('no-verdict-item', null)],
      [legacyRow('legacy-off-item', 'candidate', 'off'), legacyRow('legacy-off-item', 'candidate', 'off'),
        futureRow('future-full-item', 'full', 'full'), futureRow('no-verdict-item', 'off', 'off')]);
    expect(rows.arms.off).toEqual({ passed: 1, failed: 0, unknown: 1, passRate: 1 });
    expect(rows.arms.full).toEqual({ passed: 0, failed: 1, unknown: 0, passRate: 0 });
    expect(rows.excludedMixed).toBe(0);
    expect(rows.unassigned).toBe(0);
  });

  it('never maps legacy arm names onto current arms: the parity flip lands in level and marks the item mixed', () => {
    const rows = summarizeCheckerPassRates([item('cross-era', 'PASS')],
      [legacyRow('cross-era', 'control', 'full'), futureRow('cross-era', 'off', 'off')]);
    expect(rows.excludedMixed).toBe(1);
    expect(rows.arms.off.passed).toBe(0);
    expect(rows.arms.full.passed).toBe(0);
    expect(rows.unassigned).toBe(0);
  });

  it('counts the verifier verdict alone: a code-integration PASS with documentComplete false is a pass', () => {
    const rows = summarizeCheckerPassRates([item('partial-pass', 'PASS', false)], [futureRow('partial-pass', 'off', 'off')]);
    expect(rows.arms.off).toEqual({ passed: 1, failed: 0, unknown: 0, passRate: 1 });
  });

  it('ignores the non-policy record rows the report reads from the same log', () => {
    const rows = summarizeCheckerPassRates([item('records-item', 'PASS')],
      [futureRow('records-item', 'full', 'full'),
        { provider: 'codex', recordType: 'helper-count', threadId: 'future-records-item', helperThreads: 2 },
        { provider: 'codex', recordType: 'child-outcome', threadId: 'future-records-item', instanceId: 'i1', parentId: 'p1', success: true, exitCode: 0 },
        { provider: 'codex', recordType: 'review-outcome', threadId: 'future-records-item', instanceId: 'i1', verdict: 'APPROVED' }]);
    expect(rows.arms.full.passed).toBe(1);
    expect(rows.excludedMixed).toBe(0);
  });
});
