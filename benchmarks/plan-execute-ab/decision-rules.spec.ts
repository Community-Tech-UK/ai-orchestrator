import { describe, expect, it } from 'vitest';
import { evaluateDecisionRules, claudeTokenSaving, solvedRate } from './decision-rules';
import type { ArmSummary, RunCoverageCell, SpeedGateDecision } from './types';

function summary(
  armId: ArmSummary['armId'],
  solved: number,
  runs: number,
  avgClaudeTokens = 1_000_000,
  avgLocalTokens = 0,
  tasks = runs,
): ArmSummary {
  return {
    armId,
    runs,
    solved,
    solvedRate: runs > 0 ? solved / runs : 0,
    hiddenTestPass: solved,
    damageClean: runs,
    avgDurationMs: 60_000,
    avgCoderOutputTokens: 10_000,
    avgClaudeTokens,
    avgLocalTokens,
    judgeWins: 0,
    judgeLosses: 0,
    judgeTies: 0,
    judgeUnavailable: 0,
    failureModes: { looped: 0, toolCallErrors: 0, hitTurnCap: 0, gaveUp: 0, error: 0 },
    tasks,
    solvedRateCI95: { low: 0, high: 1 },
    hiddenTestPassRateCI95: { low: 0, high: 1 },
    servingSetups: [],
    mixedServingSetup: false,
  };
}

/**
 * Run cells for one arm: `runsPerTask` DISTINCT run numbers per task. The plan's
 * fairness controls fix these counts (1 per task in the pilot; 3 cloud / 2
 * local per task in the full run), so fixtures encode them literally rather
 * than borrowing production logic that could drift with them.
 */
function matrixRuns(taskCount: number, runsPerTask: number, prefix = 'T'): RunCoverageCell[] {
  return Array.from({ length: taskCount }, (_, task) =>
    Array.from({ length: runsPerTask }, (_, run) => ({
      taskId: `${prefix}-${task + 1}`,
      runNumber: run + 1,
    }))).flat();
}

const fullCloudRuns = (taskCount = 30): RunCoverageCell[] => matrixRuns(taskCount, 3);
const fullLocalRuns = (taskCount = 30): RunCoverageCell[] => matrixRuns(taskCount, 2);
const pilotRuns = (taskCount = 10): RunCoverageCell[] => matrixRuns(taskCount, 1);

const passGate: SpeedGateDecision = {
  keepC2: true,
  sample: {
    promptTokensPerSec: 400,
    writeTokensPerSec: 20,
    promptTokens: 30_000,
    writeTokens: 200,
    durationMs: 10_000,
    measuredPromptSpeed: true,
  },
  reasons: ['clears gate'],
};

describe('decision rules', () => {
  it('waits for all ten pilot tasks even if every arm has the same early subset', () => {
    const outcomes = evaluateDecisionRules(
      [summary('A', 2, 2), summary('C1', 0, 2), summary('C2', 0, 2)], passGate, 'pilot',
      { A: pilotRuns(2), C1: pilotRuns(2), C2: pilotRuns(2) },
    );
    for (const outcome of outcomes.filter((o) => !o.rule.includes('speed gate'))) {
      expect(outcome.triggered).toBe(false);
      expect(outcome.detail).toContain('not evaluable');
    }
  });

  it('uses hidden-test rates for the stop rule even when damage checks fail', () => {
    const c1 = { ...summary('C1', 0, 10), hiddenTestPass: 8 };
    const c2 = { ...summary('C2', 0, 10), hiddenTestPass: 7 };
    const stop = evaluateDecisionRules([summary('A', 8, 10), c1, c2], passGate, 'pilot', {
      A: pilotRuns(10), C1: pilotRuns(10), C2: pilotRuns(10),
    })
      .find((o) => o.rule.includes('pilot stop rule'));
    expect(stop?.triggered).toBe(false);
    expect(stop?.detail).toContain('80%');
  });

  it('does not turn a partial local arm into a pilot decision', () => {
    const outcomes = evaluateDecisionRules(
      [summary('A', 8, 10), summary('C1', 0, 2), summary('C2', 0, 10)], passGate, 'pilot',
      { A: pilotRuns(10), C1: pilotRuns(2), C2: pilotRuns(10) },
    );
    for (const outcome of outcomes.filter((o) => !o.rule.includes('speed gate'))) {
      expect(outcome.triggered).toBe(false);
      expect(outcome.detail).toContain('not evaluable');
    }
  });

  it('waits for C2 unless its speed gate explicitly dropped it', () => {
    const arms = [summary('A', 8, 10), summary('C1', 0, 10)];
    const cells = { A: pilotRuns(10), C1: pilotRuns(10) };
    const pending = evaluateDecisionRules(arms, passGate, 'pilot', cells).find((o) => o.rule.includes('pilot stop rule'));
    expect(pending?.triggered).toBe(false);
    expect(pending?.detail).toContain('not evaluable');
    const dropped = evaluateDecisionRules(arms, { ...passGate, keepC2: false }, 'pilot', cells).find((o) => o.rule.includes('pilot stop rule'));
    expect(dropped?.triggered).toBe(true);
  });

  it('triggers the pilot stop rule when the better local arm is more than 25 points behind A', () => {
    const outcomes = evaluateDecisionRules(
      [summary('A', 8, 10), summary('C1', 4, 10), summary('C2', 3, 10)],
      passGate,
      'pilot',
      { A: pilotRuns(10), C1: pilotRuns(10), C2: pilotRuns(10) },
    );
    const stop = outcomes.find((o) => o.rule.includes('pilot stop rule'));
    expect(stop?.triggered).toBe(true);
  });

  it('does not stop the pilot inside the 25-point margin', () => {
    const outcomes = evaluateDecisionRules(
      [summary('A', 8, 10), summary('C1', 6, 10), summary('C2', 5, 10)],
      passGate,
      'pilot',
      { A: pilotRuns(10), C1: pilotRuns(10), C2: pilotRuns(10) },
    );
    const stop = outcomes.find((o) => o.rule.includes('pilot stop rule'));
    expect(stop?.triggered).toBe(false);
  });

  it('treats the stop rule as not evaluable when no local arm has run', () => {
    const outcomes = evaluateDecisionRules([summary('A', 8, 10)], passGate, 'pilot', { A: pilotRuns(10) });
    const stop = outcomes.find((o) => o.rule.includes('pilot stop rule'));
    expect(stop?.triggered).toBe(false);
    expect(stop?.detail).toContain('not evaluable');
  });

  it('drops C2 when it does not beat C1 clearly and keeps C1 only', () => {
    const outcomes = evaluateDecisionRules(
      [summary('A', 8, 10), summary('C1', 7, 10), summary('C2', 7, 10)],
      passGate,
      'pilot',
      { A: pilotRuns(10), C1: pilotRuns(10), C2: pilotRuns(10) },
    );
    const c1c2 = outcomes.find((o) => o.rule.includes('C1 vs C2'));
    expect(c1c2?.triggered).toBe(true);
    expect(c1c2?.detail).toContain('C1 only');
  });

  it('triggers the speed-gate rule when C2 cannot hold the floor', () => {
    const failGate: SpeedGateDecision = { ...passGate, keepC2: false, reasons: ['prompt speed too low'] };
    const outcomes = evaluateDecisionRules([summary('A', 8, 10)], failGate, 'pilot');
    const gate = outcomes.find((o) => o.rule.includes('speed gate'));
    expect(gate?.triggered).toBe(true);
  });

  it('recommends building plan-locally when a local arm is close and Claude tokens drop 60%+', () => {
    const outcomes = evaluateDecisionRules(
      [summary('A', 72, 90, 1_000_000, 0, 30), summary('C1', 48, 60, 300_000, 0, 30)],
      passGate,
      'full',
      { A: fullCloudRuns(), C1: fullLocalRuns() },
    );
    const local = outcomes.find((o) => o.rule.includes('build plan-locally'));
    expect(local?.triggered).toBe(true);
  });

  it('does not count local-model tokens as Claude tokens in the saving rule', () => {
    // Regression: A burns 1,000 Claude tokens; equally successful C1 burns 100
    // Claude planner tokens plus 1,000 LOCAL coder tokens — the actual
    // Claude-token reduction is 90%, not 0%.
    const outcomes = evaluateDecisionRules(
      [summary('A', 72, 90, 1_000, 0, 30), summary('C1', 48, 60, 100, 1_000, 30)],
      passGate,
      'full',
      { A: fullCloudRuns(), C1: fullLocalRuns() },
    );
    const local = outcomes.find((o) => o.rule.includes('build plan-locally'));
    expect(local?.triggered).toBe(true);
    expect(local?.detail).toContain('Claude-token saving 90%');
  });

  it('points at Sonnet when D is close but local arms trail', () => {
    const outcomes = evaluateDecisionRules(
      [summary('A', 81, 90, 1_000_000, 0, 30), summary('D', 81, 90, 1_000_000, 0, 30), summary('C1', 24, 60, 1_000_000, 0, 30)],
      passGate,
      'full',
      { A: fullCloudRuns(), D: fullCloudRuns(), C1: fullLocalRuns() },
    );
    const sonnet = outcomes.find((o) => o.rule.includes('Sonnet'));
    expect(sonnet?.triggered).toBe(true);
  });

  it('says keep subscriptions when every cheaper arm is well behind', () => {
    const outcomes = evaluateDecisionRules(
      [
        summary('A', 90, 90, 1_000_000, 0, 30),
        summary('B', 12, 60, 1_000_000, 0, 30),
        summary('C1', 18, 60, 1_000_000, 0, 30),
        summary('D', 36, 90, 1_000_000, 0, 30),
      ],
      passGate,
      'full',
      { A: fullCloudRuns(), B: fullLocalRuns(), C1: fullLocalRuns(), D: fullCloudRuns() },
    );
    const keep = outcomes.find((o) => o.rule.includes('keep the subscriptions'));
    expect(keep?.triggered).toBe(true);
  });

  it('computes token saving against the baseline arm', () => {
    expect(claudeTokenSaving(summary('A', 8, 10, 1_000), summary('C1', 8, 10, 400))).toBeCloseTo(0.6);
    expect(solvedRate(summary('C2', 5, 10))).toBeCloseTo(0.5);
    expect(solvedRate(undefined)).toBe(0);
  });
});

describe('decision rules require matched, complete task coverage', () => {
  const fullTasks = (prefix: string, count: number): string[] =>
    Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);

  it('will not claim a token saving from a single run on a different task', () => {
    // Regression: the full-run rules compared raw rates with no task matching,
    // so one cheap run on another task could claim a 90% saving against A.
    const outcomes = evaluateDecisionRules(
      [summary('A', 72, 90, 1_000_000, 0, 30), { ...summary('C1', 1, 2, 100_000, 0, 1) }],
      passGate,
      'full',
      { A: fullCloudRuns(), C1: [{ taskId: 'T-7', runNumber: 1 }, { taskId: 'T-7', runNumber: 2 }] },
    );
    const local = outcomes.find((o) => o.rule.includes('build plan-locally'));
    expect(local?.triggered).toBe(false);
    expect(local?.detail).toContain('not evaluable');
  });

  it('withholds every full-run recommendation on a partial batch', () => {
    // cmdRun emits a report after every batch; mid-matrix arms must not let any
    // recommendation fire before matched, complete coverage exists.
    const outcomes = evaluateDecisionRules(
      [
        summary('A', 36, 45, 1_000_000, 0, 15),
        summary('C1', 24, 30, 1_000_000, 0, 15),
        summary('D', 36, 45, 1_000_000, 0, 15),
        summary('B', 6, 30, 1_000_000, 0, 15),
      ],
      passGate,
      'full',
      {
        A: fullCloudRuns(15), C1: fullLocalRuns(15), D: fullCloudRuns(15), B: fullLocalRuns(15),
      },
      fullTasks('T', 30),
    );
    for (const outcome of outcomes.filter((o) => !o.rule.includes('speed gate'))) {
      expect(outcome.triggered).toBe(false);
    }
    const local = outcomes.find((o) => o.rule.includes('build plan-locally'));
    expect(local?.detail).toContain('not evaluable');
  });

  it('recommends only when the arms cover the same complete expected matrix', () => {
    const ids = fullTasks('T', 30);
    const outcomes = evaluateDecisionRules(
      [summary('A', 72, 90, 1_000_000, 0, 30), summary('C1', 48, 60, 300_000, 0, 30)],
      passGate,
      'full',
      { A: fullCloudRuns(), C1: fullLocalRuns() },
      ids,
    );
    const local = outcomes.find((o) => o.rule.includes('build plan-locally'));
    expect(local?.triggered).toBe(true);
    expect(local?.detail).toContain('Claude-token saving 70%');
  });

  it('blocks the cheaper-arms rule while any cheaper arm is mid-batch', () => {
    const ids = fullTasks('T', 30);
    const outcomes = evaluateDecisionRules(
      [
        summary('A', 90, 90, 1_000_000, 0, 30),
        summary('B', 12, 60, 1_000_000, 0, 30),
        summary('D', 36, 90, 1_000_000, 0, 30),
        { ...summary('C1', 4, 30, 1_000_000, 0, 15) },
      ],
      passGate,
      'full',
      { A: fullCloudRuns(), B: fullLocalRuns(), D: fullCloudRuns(), C1: fullLocalRuns(15) },
      ids,
    );
    const keep = outcomes.find((o) => o.rule.includes('keep the subscriptions'));
    expect(keep?.triggered).toBe(false);
    expect(keep?.detail).toContain('not evaluable');
  });

  it('does not recommend Sonnet over locals whose coverage is unmatched', () => {
    const ids = fullTasks('T', 30);
    const outcomes = evaluateDecisionRules(
      [summary('A', 81, 90, 1_000_000, 0, 30), summary('D', 81, 90, 1_000_000, 0, 30), { ...summary('C1', 4, 4, 1_000_000, 0, 2) }],
      passGate,
      'full',
      { A: fullCloudRuns(), D: fullCloudRuns(), C1: fullLocalRuns(2) },
      ids,
    );
    const sonnet = outcomes.find((o) => o.rule.includes('Sonnet'));
    expect(sonnet?.triggered).toBe(false);
    expect(sonnet?.detail).toContain('not evaluable');
  });

  it('will not recommend from one run per task when the full run requires repeat runs', () => {
    // Regression (verifier round): 30 matching tasks with exactly one A run and
    // one C1 run per task triggered "Claude-token saving 90%" — but the plan's
    // fairness control requires 3 cloud runs and 2 local runs per task, leaving
    // 60 A and 30 C1 repeats absent. Repeat-cell completeness must withhold.
    const ids = fullTasks('T', 30);
    const outcomes = evaluateDecisionRules(
      [summary('A', 24, 30, 1_000, 0, 30), summary('C1', 24, 30, 100, 1_000, 30)],
      passGate,
      'full',
      { A: matrixRuns(30, 1), C1: matrixRuns(30, 1) },
      ids,
    );
    const local = outcomes.find((o) => o.rule.includes('build plan-locally'));
    expect(local?.triggered).toBe(false);
    expect(local?.detail).toContain('not evaluable');
  });

  it('counts repeat slots by distinct run number, not by record count', () => {
    // Uniqueness: three records sharing run number 1 fill ONE slot — duplicated
    // appends or re-runs of the same numbered slot cannot satisfy 3/2 repeats.
    const duplicated = (taskCount: number, copies: number): RunCoverageCell[] =>
      Array.from({ length: taskCount }, (_, task) =>
        Array.from({ length: copies }, () => ({ taskId: `T-${task + 1}`, runNumber: 1 }))).flat();
    const outcomes = evaluateDecisionRules(
      [summary('A', 72, 90, 1_000, 0, 30), summary('C1', 48, 60, 100, 1_000, 30)],
      passGate,
      'full',
      { A: duplicated(30, 3), C1: duplicated(30, 2) },
      fullTasks('T', 30),
    );
    const local = outcomes.find((o) => o.rule.includes('build plan-locally'));
    expect(local?.triggered).toBe(false);
    expect(local?.detail).toContain('not evaluable');
  });

  it('withholds every rule when run cells are absent (coverage cannot be verified)', () => {
    const outcomes = evaluateDecisionRules(
      [summary('A', 72, 90, 1_000, 0, 30), summary('C1', 48, 60, 100, 1_000, 30)],
      passGate,
      'full',
    );
    for (const outcome of outcomes.filter((o) => !o.rule.includes('speed gate'))) {
      expect(outcome.triggered).toBe(false);
    }
    const local = outcomes.find((o) => o.rule.includes('build plan-locally'));
    expect(local?.detail).toContain('not evaluable');
  });

  it('withholds full-run rules when the task bank is smaller than the plan matrix', () => {
    // Regression (verifier round): a ten-task pilot bank filled completely
    // still cannot make a "full" run — steps 12-13 require thirty tasks.
    const ids = fullTasks('T', 10);
    const outcomes = evaluateDecisionRules(
      [summary('A', 24, 30, 1_000, 0, 10), summary('C1', 16, 20, 100, 1_000, 10)],
      passGate,
      'full',
      { A: matrixRuns(10, 3), C1: matrixRuns(10, 2) },
      ids,
    );
    const local = outcomes.find((o) => o.rule.includes('build plan-locally'));
    expect(local?.triggered).toBe(false);
    expect(local?.detail).toContain('task bank supplies 10 tasks');
    expect(local?.detail).toContain('not evaluable');
    // Same matrix size at the plan's pilot scale is complete for pilot rules.
    const pilot = evaluateDecisionRules(
      [summary('A', 8, 10), summary('C1', 3, 10), summary('C2', 3, 10)],
      passGate,
      'pilot',
      { A: pilotRuns(10), C1: pilotRuns(10), C2: pilotRuns(10) },
      ids,
    );
    const stop = pilot.find((o) => o.rule.includes('pilot stop rule'));
    expect(stop?.triggered).toBe(true);
    expect(stop?.detail).not.toContain('task bank supplies');
  });

  it('withholds rules for an arm that mixes serving setups (fairness control)', () => {
    // Regression (verifier round): C1's retained cells mixed the LM Studio route
    // with the standalone llama-server without the arm restart the fairness
    // control requires. A mixed arm is never valid combined evidence.
    const ids = fullTasks('T', 30);
    const mixed = { ...summary('C1', 48, 60, 100, 1_000, 30) };
    mixed.servingSetups = ['lmstudio-0.4.25-27b-65536', 'llama-server-2.60.0-27b-65536'];
    mixed.mixedServingSetup = true;
    const outcomes = evaluateDecisionRules(
      [summary('A', 72, 90, 1_000, 0, 30), mixed],
      passGate,
      'full',
      { A: fullCloudRuns(), C1: fullLocalRuns() },
      ids,
    );
    const local = outcomes.find((o) => o.rule.includes('build plan-locally'));
    expect(local?.triggered).toBe(false);
    expect(local?.detail).toContain('serving setups');
    expect(local?.detail).toContain('not evaluable');
  });
});
