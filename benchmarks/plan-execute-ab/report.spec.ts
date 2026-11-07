import { describe, expect, it } from 'vitest';
import { buildReport, renderReportMarkdown, summarizeArm } from './report';
import type { JudgePairResult, RunRecord, SpeedGateSample } from './types';
import { emptyUsage } from './types';

function run(armId: RunRecord['armId'], solved: boolean, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    taskId: 'T-1',
    armId,
    runNumber: 1,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 120_000,
    workspaceDir: '/tmp/x',
    planUsed: armId !== 'A',
    plannerUsage: emptyUsage(),
    coderUsage: { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
    takeoverUsage: emptyUsage(),
    turns: 4,
    flags: { looped: false, toolCallErrors: 0, hitTurnCap: false, gaveUp: false },
    score: {
      hiddenTests: { passed: solved, command: ['true'], exitCode: solved ? 0 : 1, timedOut: false, outputTail: '' },
      damage: [],
      damageOk: true,
    },
    patchPath: '/tmp/x.patch',
    ...extra,
  };
}

function pair(armId: JudgePairResult['armId'], judge: JudgePairResult['judge'], verdict: JudgePairResult['verdict']): JudgePairResult {
  return { taskId: 'T-1', armId, judge, orders: [], verdict };
}

describe('report', () => {
  it('splits Claude from local tokens and drives the saving rule on Claude tokens alone', () => {
    // Regression: A uses 1,000 Claude tokens; equally successful C1 uses 100
    // Claude planner tokens plus 1,000 local coder tokens. The actual
    // Claude-token reduction is 90% — the rule must not compare local tokens.
    const aRun = run('A', true, {
      taskId: 'T-1',
      coderUsage: { inputTokens: 400, outputTokens: 600, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    const c1Run = run('C1', true, {
      taskId: 'T-1',
      plannerUsage: { inputTokens: 50, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      coderUsage: { inputTokens: 300, outputTokens: 700, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    const aSummary = summarizeArm('A', [aRun], []);
    const c1Summary = summarizeArm('C1', [c1Run], []);
    expect(aSummary.avgClaudeTokens).toBeCloseTo(1_000);
    expect(aSummary.avgLocalTokens).toBe(0);
    expect(c1Summary.avgClaudeTokens).toBeCloseTo(100);
    expect(c1Summary.avgLocalTokens).toBeCloseTo(1_000);

    // Full-phase rules also need the plan's complete matrix: thirty tasks
    // (steps 12-13) each filled with the repeat slots the fairness control
    // requires (3 cloud / 2 local — distinct run numbers). That complete
    // repeated matrix evaluates.
    const tasks = Array.from({ length: 30 }, (_, index) => `T-${index + 1}`);
    const fullA = tasks.flatMap((taskId, index) => [1, 2, 3].map((runNumber) => ({
      ...run('A', index < 24, {
        taskId,
        coderUsage: { inputTokens: 400, outputTokens: 600, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
      runNumber,
    })));
    const fullC1 = tasks.flatMap((taskId, index) => [1, 2].map((runNumber) => ({
      ...run('C1', index < 24, {
        taskId,
        plannerUsage: { inputTokens: 50, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
        coderUsage: { inputTokens: 300, outputTokens: 700, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
      runNumber,
    })));
    const report = buildReport('/tmp/session', [...fullA, ...fullC1], [], null, 'full', [], [], null, tasks);
    const local = report.decisionRules.find((o) => o.rule.includes('build plan-locally'));
    expect(local?.triggered).toBe(true);
    expect(local?.detail).toContain('Claude-token saving 90%');

    // One run per task never fills the repeat slots, even with the full
    // expected matrix present.
    const singles = buildReport(
      '/tmp/session',
      [
        ...tasks.map((taskId) => ({ ...aRun, taskId, runNumber: 1 })),
        ...tasks.map((taskId) => ({ ...c1Run, taskId, runNumber: 1 })),
      ],
      [],
      null,
      'full',
      [],
      [],
      null,
      tasks,
    );
    const withheldSingles = singles.decisionRules.find((o) => o.rule.includes('build plan-locally'));
    expect(withheldSingles?.triggered).toBe(false);
    expect(withheldSingles?.detail).toContain('not evaluable');

    // Regression: without the expected matrix the same partial data must not
    // recommend anything — cmdRun emits a report after every batch.
    const partial = buildReport('/tmp/session', [aRun, c1Run], [], null, 'full');
    const withheld = partial.decisionRules.find((o) => o.rule.includes('build plan-locally'));
    expect(withheld?.triggered).toBe(false);
    expect(withheld?.detail).toContain('not evaluable');

    // Regression (verifier round): a ten-task pilot bank filled completely
    // still cannot make a "full" run — steps 12-13 need thirty tasks.
    const pilotTasks = tasks.slice(0, 10);
    const pilotMatrix = [
      ...pilotTasks.flatMap((taskId, index) => [1, 2, 3].map((runNumber) => ({
        ...run('A', index < 8, { taskId }), runNumber,
      }))),
      ...pilotTasks.flatMap((taskId, index) => [1, 2].map((runNumber) => ({
        ...run('C1', index < 8, { taskId }), runNumber,
      }))),
    ];
    const tooSmall = buildReport('/tmp/session', pilotMatrix, [], null, 'full', [], [], null, pilotTasks);
    const smallRule = tooSmall.decisionRules.find((o) => o.rule.includes('build plan-locally'));
    expect(smallRule?.triggered).toBe(false);
    expect(smallRule?.detail).toContain('task bank supplies 10 tasks');
    expect(smallRule?.detail).toContain('not evaluable');
  });

  it('withholds pilot decisions for different task sets even when task counts match', () => {
    const report = buildReport('/tmp/session', [
      run('A', true, { taskId: 'T-1' }),
      run('C1', false, { taskId: 'T-2' }),
      run('C2', false, { taskId: 'T-3' }),
    ], [], null, 'pilot');
    for (const rule of report.decisionRules.filter((o) => !o.rule.includes('speed gate'))) {
      expect(rule.triggered).toBe(false);
      expect(rule.detail).toContain('not evaluable');
    }
  });

  it('summarises solves, timings and failure modes per arm', () => {
    const summary = summarizeArm('C1', [run('C1', true), run('C1', false, {
      runNumber: 2,
      flags: { looped: true, toolCallErrors: 3, hitTurnCap: true, gaveUp: false },
    })], [pair('C1', 'claude', 'arm-win')]);
    expect(summary.solved).toBe(1);
    expect(summary.solvedRate).toBeCloseTo(0.5);
    expect(summary.judgeWins).toBe(1);
    expect(summary.failureModes.looped).toBe(1);
    expect(summary.failureModes.hitTurnCap).toBe(1);
  });

  it('counts judge agreement and never lets judges override tests', () => {
    const report = buildReport(
      '/tmp/session',
      [run('A', true), run('D', false)],
      [pair('D', 'claude', 'arm-win'), pair('D', 'codex', 'arm-win')],
      null,
      'pilot',
    );
    // One task-arm pair answered by both judges (not two individual results);
    // both verdicts conflict with the hidden tests (D fails, A passes, and both
    // judges preferred the failing side — tests never get overridden).
    expect(report.judgeAgreement.bothJudgesCalled).toBe(1);
    expect(report.judgeAgreement.sameVerdict).toBe(1);
    expect(report.judgeAgreement.conflictsWithHiddenTests).toBe(2);
  });

  it('counts both-judge pairs by task-arm, not by individual judge results', () => {
    // Regression (verifier round): one pair answered identically by Claude and
    // Codex reported bothJudgesCalled=2 / sameVerdict=1 (1/2) — the denominator
    // counted results. A pair is a task-arm with ONE available verdict from
    // EACH judge; agreement is over those pairs (1/1 here).
    const both = buildReport(
      '/tmp/session',
      [run('A', true), run('D', true)],
      [pair('D', 'claude', 'arm-win'), pair('D', 'codex', 'arm-win')],
      null,
      'pilot',
    );
    expect(both.judgeAgreement.bothJudgesCalled).toBe(1);
    expect(both.judgeAgreement.sameVerdict).toBe(1);

    // A lone judge never makes a pair, and two results from one judge are one
    // side answering twice.
    const lone = buildReport(
      '/tmp/session',
      [run('A', true), run('D', true)],
      [pair('D', 'claude', 'arm-win')],
      null,
      'pilot',
    );
    expect(lone.judgeAgreement.bothJudgesCalled).toBe(0);
    const oneJudgeTwice = buildReport(
      '/tmp/session',
      [run('A', true), run('D', true)],
      [pair('D', 'claude', 'arm-win'), pair('D', 'claude', 'tie')],
      null,
      'pilot',
    );
    expect(oneJudgeTwice.judgeAgreement.bothJudgesCalled).toBe(0);

    // Disagreeing judges still answer the pair.
    const split = buildReport(
      '/tmp/session',
      [run('A', true), run('D', true)],
      [pair('D', 'claude', 'arm-win'), pair('D', 'codex', 'baseline-win')],
      null,
      'pilot',
    );
    expect(split.judgeAgreement.bothJudgesCalled).toBe(1);
    expect(split.judgeAgreement.sameVerdict).toBe(0);
  });

  it('never labels a preference a conflict with hidden tests when both patches pass', () => {
    // Regression (verifier round): with passing hidden tests on BOTH sides the
    // tests express no preference, so judges preferring either side agree with
    // them. The old code looked only at the arm's isSolved (dragging damage
    // into a hidden-test metric) and counted every baseline-win as a conflict.
    const report = buildReport(
      '/tmp/session',
      [run('A', true), run('D', true)],
      [pair('D', 'claude', 'baseline-win'), pair('D', 'codex', 'baseline-win')],
      null,
      'pilot',
    );
    expect(report.judgeAgreement.conflictsWithHiddenTests).toBe(0);

    // Preferring the side the tests mark worse conflicts; the opposite
    // preference and ties never do.
    const preferWorse = buildReport(
      '/tmp/session',
      [run('A', true), run('D', false)],
      [pair('D', 'claude', 'arm-win'), pair('D', 'codex', 'tie')],
      null,
      'pilot',
    );
    expect(preferWorse.judgeAgreement.conflictsWithHiddenTests).toBe(1);
    const preferBetter = buildReport(
      '/tmp/session',
      [run('A', false), run('D', true)],
      [pair('D', 'claude', 'arm-win'), pair('D', 'codex', 'baseline-win')],
      null,
      'pilot',
    );
    expect(preferBetter.judgeAgreement.conflictsWithHiddenTests).toBe(1);

    // The metric is hidden-test agreement only: a damage failure next to
    // passing tests on both sides is not a hidden-test conflict.
    const cleanScore = {
      hiddenTests: { passed: true, command: ['true'], exitCode: 0, timedOut: false, outputTail: '' },
      damage: [],
      damageOk: true,
    };
    const damageOnly = buildReport(
      '/tmp/session',
      [
        run('A', true, { score: cleanScore }),
        run('D', true, { score: { ...cleanScore, damageOk: false } }),
      ],
      [pair('D', 'claude', 'baseline-win')],
      null,
      'pilot',
    );
    expect(damageOnly.judgeAgreement.conflictsWithHiddenTests).toBe(0);
  });

  it('withholds full-run recommendations until the plan repeat runs exist', () => {
    // Regression (verifier round): 30 matching tasks with exactly one A run and
    // one C1 run per task returned triggered=true / "Claude-token saving 90%"
    // on phase=full — but the fairness control requires 3 cloud runs and 2
    // local runs per task (60 A and 30 C1 repeats absent there).
    const tasks = Array.from({ length: 30 }, (_, index) => `T-${index + 1}`);
    const aRuns = tasks.map((taskId, index) => run('A', index < 24, {
      taskId,
      coderUsage: { inputTokens: 400, outputTokens: 600, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }));
    const c1Runs = tasks.map((taskId, index) => run('C1', index < 24, {
      taskId,
      plannerUsage: { inputTokens: 50, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      coderUsage: { inputTokens: 300, outputTokens: 700, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }));
    const report = buildReport('/tmp/session', [...aRuns, ...c1Runs], [], null, 'full', [], [], null, tasks);
    const local = report.decisionRules.find((o) => o.rule.includes('build plan-locally'));
    expect(local?.triggered).toBe(false);
    expect(local?.detail).toContain('not evaluable');
  });

  it('flags an arm that mixes serving setups (fairness control)', () => {
    // The fairness control requires one server/settings setup per arm; the
    // report must surface a mix and never treat the combined arm as evidence.
    const mixed = summarizeArm('C1', [
      run('C1', true, { servingSetupId: 'lmstudio-0.4.25-27b-65536' }),
      run('C1', true, { runNumber: 2, servingSetupId: 'llama-server-2.60.0-27b-65536' }),
    ], []);
    expect(mixed.mixedServingSetup).toBe(true);
    expect(mixed.servingSetups).toEqual([
      'llama-server-2.60.0-27b-65536',
      'lmstudio-0.4.25-27b-65536',
    ]);
    const settled = summarizeArm('C1', [
      run('C1', true, { servingSetupId: 'llama-server-2.60.0-27b-65536' }),
    ], []);
    expect(settled.mixedServingSetup).toBe(false);
    const unrecorded = summarizeArm('C1', [run('C1', true)], []);
    expect(unrecorded.servingSetups).toEqual(['unrecorded']);
    const cloud = summarizeArm('A', [run('A', true)], []);
    expect(cloud.servingSetups).toEqual([]);
    expect(cloud.mixedServingSetup).toBe(false);
  });

  it('counts one record per run cell and says so when duplicates are ignored', () => {
    // Regression (verifier repro): two copies of one successful record moved
    // C1 from 5/10 to 7/12 and switched the pilot stop rule off. A duplicated
    // record of a slot is the same evidence again, never more of it.
    const tasks = Array.from({ length: 10 }, (_, index) => `T-${index + 1}`);
    const hidden = (passed: boolean) => ({
      hiddenTests: { passed, command: ['true'], exitCode: passed ? 0 : 1, timedOut: false, outputTail: '' },
      damage: [],
      damageOk: true,
    });
    // A 8/10 on hidden tests vs better of C1/C2 5/10: a 30-point gap trips the
    // pilot stop rule.
    const aRuns = tasks.map((taskId, index) => run('A', true, { taskId, score: hidden(index < 8) }));
    const c1Runs = tasks.map((taskId, index) => run('C1', true, { taskId, score: hidden(index < 5) }));
    const c2Runs = tasks.map((taskId) => run('C2', true, { taskId, score: hidden(false) }));
    const report = buildReport(
      '/tmp/session',
      [...aRuns, ...c1Runs, ...c2Runs, { ...c1Runs[0] }, { ...c1Runs[0] }],
      [],
      null,
      'pilot',
      [],
      [],
      null,
      tasks,
    );
    expect(report.notes.some((note) => note.includes('2 duplicate run record(s) ignored'))).toBe(true);
    const c1 = report.arms.find((arm) => arm.armId === 'C1');
    expect(c1?.runs).toBe(10);
    expect(c1?.hiddenTestPass).toBe(5);
    const stop = report.decisionRules.find((o) => o.rule.includes('pilot stop rule'));
    expect(stop?.triggered).toBe(true);
    expect(stop?.detail).toContain('gap 30 points');
  });

  it('scores judge conflicts on the judged runs, not a majority of other repeats', () => {
    // The pair judged C1 run 2 (hidden tests FAIL) against A run 1 (PASS) and
    // preferred the arm — a conflict. C1 run 1 passes, but that is a different
    // patch: repeats must never decide what the judged patch did.
    const judged: JudgePairResult = {
      taskId: 'T-1', armId: 'C1', judge: 'claude', orders: [], verdict: 'arm-win',
      subjectRunNumber: 2, baselineRunNumber: 1,
    };
    const report = buildReport('/tmp/session', [
      run('A', true, { taskId: 'T-1', runNumber: 1 }),
      run('C1', true, { taskId: 'T-1', runNumber: 1 }),
      run('C1', false, { taskId: 'T-1', runNumber: 2 }),
    ], [judged], null, 'pilot');
    expect(report.judgeAgreement.conflictsWithHiddenTests).toBe(1);

    // Pairs predating the run-number fields resolve to the run judgeSession
    // picked for them — the cell's first record (C1 run 1 passes: no conflict).
    const legacy: JudgePairResult = {
      taskId: 'T-1', armId: 'C1', judge: 'claude', orders: [], verdict: 'arm-win',
    };
    const legacyReport = buildReport('/tmp/session', [
      run('A', true, { taskId: 'T-1', runNumber: 1 }),
      run('C1', true, { taskId: 'T-1', runNumber: 1 }),
      run('C1', false, { taskId: 'T-1', runNumber: 2 }),
    ], [legacy], null, 'pilot');
    expect(legacyReport.judgeAgreement.conflictsWithHiddenTests).toBe(0);
  });

  it('renders markdown with the decision-rule section', () => {
    const report = buildReport('/tmp/session', [run('A', true)], [], null, 'pilot');
    const markdown = renderReportMarkdown(report);
    expect(markdown).toContain('## Results per arm');
    expect(markdown).toContain('## Pre-agreed decision rules');
    expect(markdown).toContain('| A | 1 | 1 | 1 |');
    expect(markdown).toContain('Speed gate (C2 / Flash-Next): not measured in this session');
  });

  it('retains speed-gate results and per-run local speeds in the report', () => {
    const gateSample: SpeedGateSample = {
      promptTokensPerSec: 770,
      writeTokensPerSec: 32,
      promptTokens: 30_000,
      writeTokens: 256,
      durationMs: 40_000,
      measuredPromptSpeed: true,
      source: 'wall-clock',
    };
    const decision = { keepC2: true, sample: gateSample, reasons: ['clears gate'] };
    const report = buildReport(
      '/tmp/session',
      [
        run('C1', true, { localSpeed: { promptTokensPerSec: 1_200, writeTokensPerSec: 150, source: 'wall-clock' } }),
        run('C1', true, {
          runNumber: 2,
          localSpeed: { promptTokensPerSec: null, writeTokensPerSec: null, source: 'unmeasured', note: 'probe failed' },
        }),
        run('A', true),
      ],
      [],
      decision,
      'pilot',
      [],
      [{ modelKey: 'qwen3.8-flash-next', measuredAt: '2026-10-16T00:00:00Z', sample: gateSample, decision }],
    );
    expect(report.speedGate?.keepC2).toBe(true);
    expect(report.speedSamples).toHaveLength(1);
    expect(report.arms.find((arm) => arm.armId === 'C1')?.localSpeed).toEqual({
      measuredRuns: 1,
      unmeasuredRuns: 1,
      avgPromptTokensPerSec: 1_200,
      avgWriteTokensPerSec: 150,
    });
    expect(report.arms.find((arm) => arm.armId === 'A')?.localSpeed).toBeUndefined();
    const markdown = renderReportMarkdown(report);
    expect(markdown).toContain('## Local model speeds');
    expect(markdown).toContain('qwen3.8-flash-next');
    expect(markdown).toContain('PASS — keep C2');
    expect(markdown).toContain('### Per-run probe speeds');
    expect(markdown).toContain('| C1 | 1 | 1 | 1200 | 150.0 |');
  });

  it('attaches 95% uncertainty ranges per arm, with tasks as the unit', () => {
    const tenTasks = Array.from({ length: 10 }, (_, index) =>
      run('A', index < 3, { taskId: `T-${index + 1}` }));
    const summary = summarizeArm('A', tenTasks, []);
    expect(summary.tasks).toBe(10);
    // Wilson at 3/10: about 11%–60%, centred on the reported 30%.
    expect(summary.solvedRateCI95.low).toBeCloseTo(0.10779, 4);
    expect(summary.solvedRateCI95.high).toBeCloseTo(0.60322, 4);

    // Repeat runs of one task are one task: three solved runs on a single task
    // get 1 task of evidence, not 3.
    const oneTask = summarizeArm('A', [
      run('A', true),
      run('A', true, { runNumber: 2 }),
      run('A', true, { runNumber: 3 }),
    ], []);
    expect(oneTask.tasks).toBe(1);
    expect(oneTask.solvedRateCI95.low).toBeCloseTo(0.20655, 4);
    expect(oneTask.solvedRateCI95.high).toBe(1);
  });

  it('renders uncertainty ranges and gap-vs-A readings in the markdown', () => {
    const aRuns = Array.from({ length: 10 }, (_, index) =>
      run('A', index < 3, { taskId: `T-${index + 1}` }));
    const dRuns = Array.from({ length: 10 }, (_, index) =>
      run('D', index < 3, { taskId: `T-${index + 1}` }));
    const c1Runs = [run('C1', true, { taskId: 'T-1' }), run('C1', true, { taskId: 'T-2' })];
    const report = buildReport('/tmp/session', [...aRuns, ...dRuns, ...c1Runs], [], null, 'pilot');
    const markdown = renderReportMarkdown(report);

    expect(markdown).toContain('## Uncertainty (95% ranges)');
    expect(markdown).toContain('30% (11%–60%)');
    expect(markdown).toContain('### Solved-rate gap vs arm A (percentage points)');
    // D matches A exactly: a 0-point gap whose range must include 0.
    const dGap = report.baselineGaps.find((gap) => gap.armId === 'D');
    expect(dGap?.gapPoints).toBeCloseTo(0);
    expect(dGap?.excludesZero).toBe(false);
    expect(markdown).toContain('can be noise at this size');
    // C1 is 2/2 vs A 3/10: far ahead on paper, but 2 tasks of evidence.
    const c1Gap = report.baselineGaps.find((gap) => gap.armId === 'C1');
    expect(c1Gap?.gapPoints).toBeCloseTo(70);
    expect(c1Gap?.excludesZero).toBe(false);
  });

  it('marks a gap bigger than noise and skips gaps when arm A is absent', () => {
    const winner = Array.from({ length: 10 }, (_, index) =>
      run('D', true, { taskId: `T-${index + 1}` }));
    const loser = Array.from({ length: 10 }, (_, index) =>
      run('A', false, { taskId: `T-${index + 1}` }));
    const report = buildReport('/tmp/session', [...winner, ...loser], [], null, 'pilot');
    const gap = report.baselineGaps.find((entry) => entry.armId === 'D');
    expect(gap?.excludesZero).toBe(true);

    const withoutA = buildReport('/tmp/session', winner, [], null, 'pilot');
    expect(withoutA.baselineGaps).toEqual([]);
    expect(renderReportMarkdown(withoutA)).toContain('Arm A has no runs in this session');
  });

  it('renders cost per solved task from metered cost evidence', () => {
    const report = buildReport(
      '/tmp/session',
      [run('A', true), run('A', false, { taskId: 'T-2' }), run('D', true)],
      [],
      null,
      'pilot',
      [],
      [],
      {
        coderUsdByRun: { 'T-1|A|1': 3, 'T-2|A|1': 1, 'T-1|D|1': 0.5 },
        takeoverUsdByRun: {},
        plannerUsdByTask: { 'T-1': 0.25 },
        judgeMeteredUsd: 2,
      },
    );
    const markdown = renderReportMarkdown(report);
    expect(markdown).toContain('## Cost (metered USD)');
    // A: $4 metered over 1 solve; D: $0.5 coder + $0.25 plan over 1 solve.
    expect(markdown).toContain('| A | $4.00 | — | — | $4.00 | 1 | $4.00 |');
    expect(markdown).toContain('| D | $0.50 | $0.25 | — | $0.75 | 1 | $0.75 |');
    expect(markdown).toContain('Shared Claude judging: $2.00');
    expect(report.cost?.plannerMeteredUsd).toBeCloseTo(0.25);
  });

  it('says so when a session has no cost evidence', () => {
    const report = buildReport('/tmp/session', [run('A', true)], [], null, 'pilot');
    expect(report.cost).toBeNull();
    expect(renderReportMarkdown(report)).toContain('Cost evidence was not collected');
  });
});
