import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseLogCostUsd, readCostEvidence, summarizeCosts } from './cost';
import type { CostEvidence, RunRecord } from './types';
import { emptyUsage } from './types';

const RESULT_EVENT = (cost: number, type = 'result'): string =>
  JSON.stringify({ type, total_cost_usd: cost, usage: { output_tokens: 10 } });

describe('parseLogCostUsd', () => {
  it('takes one invocation cost from its result event', () => {
    expect(parseLogCostUsd(`=== banner ===\n${RESULT_EVENT(0.7)}\n`)).toBeCloseTo(0.7);
  });

  it('reads the LAST cumulative figure per invocation, never the sum of snapshots', () => {
    // Claude Code re-emits result events at segment closes; total_cost_usd is
    // cumulative (AIO-03-A in the pilot session: 2.08 -> 3.09 -> 3.23).
    const text = [
      '=== banner ===',
      RESULT_EVENT(2.08),
      RESULT_EVENT(2.08),
      RESULT_EVENT(3.09),
      RESULT_EVENT(3.09),
      RESULT_EVENT(3.23),
    ].join('\n');
    expect(parseLogCostUsd(text)).toBeCloseTo(3.23);
  });

  it('sums across appended invocations (the runner opens logs append-only)', () => {
    const text = [
      '=== first ===',
      RESULT_EVENT(1.25),
      '=== second ===',
      RESULT_EVENT(0.5),
    ].join('\n');
    expect(parseLogCostUsd(text)).toBeCloseTo(1.75);
  });

  it('ignores cost-like echoes on non-result lines and non-JSON noise', () => {
    const text = [
      '=== banner ===',
      RESULT_EVENT(0.25, 'user'),
      'some stderr [stderr] total_cost_usd: 99',
      RESULT_EVENT(1.5),
    ].join('\n');
    expect(parseLogCostUsd(text)).toBeCloseTo(1.5);
  });

  it('returns 0 for logs with no billed result', () => {
    expect(parseLogCostUsd('=== banner ===\n{"type":"assistant"}\n')).toBe(0);
  });
});

describe('readCostEvidence', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('collects coder, takeover, planner and Claude-judge costs from a session layout', () => {
    const session = mkdtempSync(join(tmpdir(), 'plan-ex-cost-'));
    dirs.push(session);
    mkdirSync(join(session, 'plans'));
    mkdirSync(join(session, 'judge'));
    writeFileSync(join(session, 'T-1-A-run1.agent.log'), `=== b ===\n${RESULT_EVENT(2)}\n`);
    writeFileSync(join(session, 'T-1-D-run1.agent.log'), `=== b ===\n${RESULT_EVENT(0.5)}\n`);
    writeFileSync(join(session, 'T-1-F-run2.takeover.log'), `=== b ===\n${RESULT_EVENT(1.25)}\n`);
    writeFileSync(join(session, 'plans', 'T-1.planner.log'), `=== b ===\n${RESULT_EVENT(0.75)}\n`);
    writeFileSync(join(session, 'judge', 'T-1-D-claude-1.log'), `=== b ===\n${RESULT_EVENT(0.1)}\n`);
    writeFileSync(join(session, 'judge', 'T-1-D-claude-2.log'), `=== b ===\n${RESULT_EVENT(0.2)}\n`);
    writeFileSync(join(session, 'judge', 'T-1-D-codex-1.log'), 'no cost fields here\n');

    const evidence = readCostEvidence(session);
    expect(evidence.coderUsdByRun).toEqual({ 'T-1|A|1': 2, 'T-1|D|1': 0.5 });
    expect(evidence.takeoverUsdByRun).toEqual({ 'T-1|F|2': 1.25 });
    expect(evidence.plannerUsdByTask).toEqual({ 'T-1': 0.75 });
    expect(evidence.judgeMeteredUsd).toBeCloseTo(0.3);
  });

  it('returns empty evidence for a missing session', () => {
    const evidence = readCostEvidence(join(tmpdir(), 'plan-ex-does-not-exist'));
    expect(evidence.coderUsdByRun).toEqual({});
    expect(evidence.judgeMeteredUsd).toBe(0);
  });
});

function run(armId: RunRecord['armId'], taskId: string, solved: boolean): RunRecord {
  return {
    taskId,
    armId,
    runNumber: 1,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 60_000,
    workspaceDir: '/tmp/x',
    planUsed: armId !== 'A' && armId !== 'B' && armId !== 'G',
    plannerUsage: emptyUsage(),
    coderUsage: emptyUsage(),
    takeoverUsage: emptyUsage(),
    turns: 3,
    flags: { looped: false, toolCallErrors: 0, hitTurnCap: false, gaveUp: false },
    score: {
      hiddenTests: { passed: solved, command: ['true'], exitCode: solved ? 0 : 1, timedOut: false, outputTail: '' },
      damage: [],
      damageOk: true,
    },
    patchPath: '/tmp/x.patch',
  };
}

function evidence(): CostEvidence {
  return {
    coderUsdByRun: {
      'T-1|A|1': 4,
      'T-2|A|1': 2,
      'T-1|D|1': 1.5,
      'T-1|C1|1': 9, // local CLI nominal estimate — never billed
      'T-1|G|1': 7, // Codex has no metered USD cost
    },
    takeoverUsdByRun: { 'T-1|F|1': 1 },
    plannerUsdByTask: { 'T-1': 0.5, 'T-2': 0.25 },
    judgeMeteredUsd: 3,
  };
}

describe('summarizeCosts', () => {
  it('charges each arm what it really costs and derives cost per solved task', () => {
    const report = summarizeCosts(evidence(), [
      run('A', 'T-1', true),
      run('A', 'T-2', true),
      run('D', 'T-1', false),
      run('C1', 'T-1', true),
      run('G', 'T-1', true),
      run('F', 'T-1', true),
    ]);
    const byArm = new Map(report.arms.map((arm) => [arm.armId, arm]));

    const a = byArm.get('A');
    expect(a?.coderMeteredUsd).toBeCloseTo(6);
    expect(a?.plannerMeteredUsd).toBe(0);
    expect(a?.costPerSolvedUsd).toBeCloseTo(3);

    const d = byArm.get('D');
    expect(d?.coderMeteredUsd).toBeCloseTo(1.5);
    expect(d?.plannerMeteredUsd).toBeCloseTo(0.5);
    expect(d?.costPerSolvedUsd).toBeNull(); // solved nothing

    const c1 = byArm.get('C1');
    expect(c1?.coderMeteredUsd).toBe(0); // the 9 in evidence is a local nominal figure
    expect(c1?.plannerMeteredUsd).toBeCloseTo(0.5);
    expect(c1?.costPerSolvedUsd).toBeCloseTo(0.5);

    const g = byArm.get('G');
    expect(g?.totalMeteredUsd).toBe(0);
    expect(g?.costPerSolvedUsd).toBe(0);

    const f = byArm.get('F');
    expect(f?.takeoverMeteredUsd).toBeCloseTo(1);
    expect(f?.plannerMeteredUsd).toBeCloseTo(0.5);
    expect(f?.costPerSolvedUsd).toBeCloseTo(1.5);

    expect(report.judgeMeteredUsd).toBeCloseTo(3);
    expect(report.plannerMeteredUsd).toBeCloseTo(0.75);
  });

  it('keeps spend from runs that were later quarantined (the money was spent)', () => {
    const withQuarantine = evidence();
    withQuarantine.coderUsdByRun['T-3|A|1'] = 2.5; // no T-3 run record survives
    const report = summarizeCosts(withQuarantine, [run('A', 'T-1', true)]);
    const a = report.arms.find((arm) => arm.armId === 'A');
    // 4 (T-1) + 2 (T-2) + 2.5 (T-3): spend comes from logs, not from surviving run records.
    expect(a?.coderMeteredUsd).toBeCloseTo(8.5);
  });
});
