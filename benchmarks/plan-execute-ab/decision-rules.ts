import { runsPerArmFor } from './arms';
import type { ArmId, ArmSummary, BenchmarkReport, DecisionRuleOutcome, RunCoverageCell, SpeedGateDecision } from './types';

const CLOSE_MARGIN_POINTS = 5;
const PILOT_STOP_MARGIN_POINTS = 25;
const LOCAL_TOKEN_SAVING_REQUIRED = 0.6;
const C2_CLEAR_MARGIN_POINTS = 20;
/** The plan's complete matrix sizes ("30 tasks for the full run, 10 for the pilot"). */
export const COMPLETE_TASKS: Record<'pilot' | 'full', number> = { pilot: 10, full: 30 };

export function solvedRate(summary: ArmSummary | undefined): number {
  return summary ? summary.solvedRate : 0;
}

/**
 * Fraction of the baseline arm's Claude tokens the candidate arm saves. Local
 * model tokens are not Claude tokens: a plan-then-code-locally arm burns Claude
 * only on planning and takeovers, and that reduction is what the plan's >= 60%
 * rule is about.
 */
export function claudeTokenSaving(baseline: ArmSummary | undefined, arm: ArmSummary | undefined): number {
  const base = baseline?.avgClaudeTokens ?? 0;
  if (!baseline || !arm || base === 0) return 0;
  return Math.max(0, (base - arm.avgClaudeTokens) / base);
}

/**
 * Pre-agreed decision rules from the plan. "Close" and "clear margin" are
 * operationalised here (5 points for close, 20 points or 2 tasks for C2's
 * clear margin) so the verdict cannot drift after results are seen.
 *
 * No rule recommends anything unless every arm it compares has MATCHED,
 * COMPLETE task coverage against arm A: the same task identities (not just
 * counts) over the session's complete matrix (`expectedTaskIds` from the task
 * bank when known, else the plan's 10/30 matrix sizes), AND the plan's repeat
 * runs per task (1 per task in the pilot; 3 cloud / 2 local per task in the
 * full run — fairness controls). Coverage comes from `cells`, one entry per
 * scored run; DISTINCT run numbers fill a task's repeat slots, so duplicated
 * records of one slot can never masquerade as completed repeats. Raw rates
 * from partial batches, single runs or different tasks are never evidence — a
 * single run on another task must not be able to claim a 90% saving.
 */
export function evaluateDecisionRules(
  summaries: ArmSummary[],
  speedGate: SpeedGateDecision | null,
  phase: 'pilot' | 'full',
  cells?: Partial<Record<ArmId, readonly RunCoverageCell[]>>,
  expectedTaskIds?: readonly string[],
): DecisionRuleOutcome[] {
  const byId = new Map(summaries.map((s) => [s.armId, s]));
  const outcomes: DecisionRuleOutcome[] = [];

  const a = byId.get('A');
  const c1 = byId.get('C1');
  const c2 = byId.get('C2');
  const d = byId.get('D');
  const e = byId.get('E');
  const cellsByArm = cells ?? {};
  const cellsFor = (armId: ArmId): readonly RunCoverageCell[] => cellsByArm[armId] ?? [];
  const taskIdsFor = (armId: ArmId): Set<string> => new Set(cellsFor(armId).map((cell) => cell.taskId));
  /** Distinct repeat slots (unique run numbers) one arm occupies on one task. */
  const distinctRunsFor = (armId: ArmId, taskId: string): number =>
    new Set(cellsFor(armId).filter((cell) => cell.taskId === taskId).map((cell) => cell.runNumber)).size;
  const sameTasks = (left: ArmSummary | undefined, right: ArmSummary | undefined): boolean => {
    if (!left || !right || left.tasks === 0 || left.tasks !== right.tasks) return false;
    const ids = taskIdsFor(left.armId);
    const other = taskIdsFor(right.armId);
    if (ids.size === 0 || other.size === 0) return false;
    return ids.size === other.size && [...ids].every((id) => other.has(id));
  };
  /**
   * Whether an arm has run the session's complete matrix with the plan's repeat
   * runs: every expected task (the bank's list when known, else the plan's 10/30
   * matrix sizes over the arm's own tasks) filled with the required number of
   * DISTINCT run slots. Repeated records sharing a run number fill one slot;
   * arms without cell evidence never qualify. The expected matrix must itself
   * be the plan's complete matrix: a ten-task pilot bank cannot make a "full"
   * run complete (steps 12-13 require thirty tasks), however completely its
   * slots are filled.
   */
  const expectedList = expectedTaskIds && expectedTaskIds.length > 0 ? [...expectedTaskIds] : [];
  const matrixTooSmall = expectedList.length > 0 && expectedList.length < COMPLETE_TASKS[phase];
  const completeFor = (arm: ArmSummary | undefined): boolean => {
    if (!arm || arm.tasks === 0) return false;
    const observed = cellsFor(arm.armId);
    if (observed.length === 0) return false;
    const required = runsPerArmFor(phase, arm.armId);
    const everySlotFilled = (taskIds: readonly string[]): boolean =>
      taskIds.every((taskId) => distinctRunsFor(arm.armId, taskId) >= required);
    if (expectedList.length > 0) {
      if (matrixTooSmall) return false;
      const expected = new Set(expectedList);
      const covered = taskIdsFor(arm.armId);
      return covered.size === expected.size
        && [...expected].every((id) => covered.has(id))
        && everySlotFilled([...expected]);
    }
    return arm.tasks >= COMPLETE_TASKS[phase] && everySlotFilled([...taskIdsFor(arm.armId)]);
  };
  /** Matched, complete coverage on both sides — the only admissible comparison. */
  const comparable = (left: ArmSummary | undefined, right: ArmSummary | undefined): boolean =>
    !left?.mixedServingSetup && !right?.mixedServingSetup
    && completeFor(left) && completeFor(right) && sameTasks(left, right);
  const coverageNote = (...arms: (ArmSummary | undefined)[]): string =>
    arms.some((arm) => arm?.mixedServingSetup)
      ? 'arm mixes serving setups (fairness control: restart that arm) — rule not evaluable yet'
      : matrixTooSmall
        ? `the task bank supplies ${expectedList.length} tasks; the plan's ${phase} run needs ${COMPLETE_TASKS[phase]} — rule not evaluable yet`
        : 'coverage or repeat-run coverage incomplete or unmatched to A — rule not evaluable yet';

  outcomes.push({
    rule: 'speed gate (setup): C2 needs 300+ prompt tok/s and 15+ write tok/s on a real 30k-token prompt',
    triggered: speedGate !== null && !speedGate.keepC2,
    detail: speedGate === null
      ? 'not measured in this session'
      : speedGate.reasons.join('; '),
  });

  if (phase === 'pilot') {
    const hiddenRate = (arm: ArmSummary | undefined): number => arm && arm.runs > 0 ? arm.hiddenTestPass / arm.runs : 0;
    const betterLocal = Math.max(hiddenRate(c1), speedGate?.keepC2 === false ? 0 : hiddenRate(c2));
    const haveLocal = comparable(a, c1) && (speedGate?.keepC2 === false || comparable(a, c2));
    const drop = hiddenRate(a) - betterLocal;
    const stop = a !== undefined && haveLocal && drop > PILOT_STOP_MARGIN_POINTS / 100;
    outcomes.push({
      rule: `pilot stop rule: stop if the better of C1/C2 is more than ${PILOT_STOP_MARGIN_POINTS} points behind A on hidden tests`,
      triggered: stop,
      detail: !a
        ? 'arm A results missing'
        : !haveLocal
          ? `C1/C2 ${coverageNote(a, c1, c2)} (unless C2 was speed-gated out)`
          : `A ${(hiddenRate(a) * 100).toFixed(0)}% vs better of C1/C2 ${(betterLocal * 100).toFixed(0)}% (gap ${(drop * 100).toFixed(0)} points)`,
    });

    const comparableLocal = comparable(a, c1) && comparable(a, c2);
    const c2BeatsC1 = comparableLocal && c1 && c2
      ? c2.solvedRate - c1.solvedRate >= C2_CLEAR_MARGIN_POINTS / 100 || c2.solved > c1.solved + 1
      : false;
    outcomes.push({
      rule: `C1 vs C2: keep C2 in the full run only if it beats C1 clearly (>= ${C2_CLEAR_MARGIN_POINTS} points or 2+ tasks)`,
      triggered: Boolean(comparableLocal && !c2BeatsC1),
      detail: comparableLocal && c1 && c2
        ? `C1 solved ${c1.solved}/${c1.runs}, C2 solved ${c2.solved}/${c2.runs} — full run keeps ${c2BeatsC1 ? 'C2 (and C1)' : 'C1 only'}`
        : `C1/C2 ${coverageNote(a, c1, c2)}`,
    });
    return outcomes;
  }

  const localArms = [c1, c2].filter(Boolean) as ArmSummary[];
  const comparableLocals = localArms.filter((arm) => comparable(a, arm));
  const localBest = [...comparableLocals].sort((x, y) => solvedRate(y) - solvedRate(x))[0];
  const localWithin = localBest && a ? a.solvedRate - localBest.solvedRate <= CLOSE_MARGIN_POINTS / 100 : false;
  const tokensDown = claudeTokenSaving(a, localBest);
  const localsUnusable = localArms.length > 0 && comparableLocals.length === 0;

  outcomes.push({
    rule: 'best local arm within ~5 points of A and Claude tokens down >= 60%: build plan-locally for small/medium tasks',
    triggered: Boolean(localBest && localWithin && tokensDown >= LOCAL_TOKEN_SAVING_REQUIRED),
    detail: localBest && a
      ? `best local ${localBest.armId} ${(localBest.solvedRate * 100).toFixed(0)}% vs A ${(a.solvedRate * 100).toFixed(0)}%, Claude-token saving ${(tokensDown * 100).toFixed(0)}%`
      : !a || localArms.length === 0
        ? 'A/local results missing'
        : `local arms present but ${coverageNote(a, ...localArms)}`,
  });

  const dEvaluable = comparable(a, d);
  const dClose = dEvaluable && a && d ? a.solvedRate - d.solvedRate <= CLOSE_MARGIN_POINTS / 100 : false;
  outcomes.push({
    rule: 'D close to A but local arms well behind: the saving sits inside Claude (Sonnet coder)',
    triggered: Boolean(dEvaluable && dClose && comparableLocals.length > 0 && !localWithin),
    detail: !d || !a
      ? 'A/D results missing'
      : !dEvaluable
        ? `D ${coverageNote(a, d)}`
        : comparableLocals.length === 0
          ? localsUnusable
            ? `local arms present but ${coverageNote(a, ...localArms)} — "local arms well behind" not established`
            : 'no comparable local-arm results — "local arms well behind" not established'
          : `D ${(d.solvedRate * 100).toFixed(0)}% vs A ${(a.solvedRate * 100).toFixed(0)}%; best local within 5 points: ${localWithin ? 'yes' : 'no'}`,
  });

  const eEvaluable = comparable(a, e);
  const eClose = eEvaluable && a && e ? a.solvedRate - e.solvedRate <= CLOSE_MARGIN_POINTS / 100 : false;
  outcomes.push({
    rule: 'E close to A but local arms well behind: cheap hosted open models are the executor to use',
    triggered: Boolean(eEvaluable && eClose && comparableLocals.length > 0 && !localWithin),
    detail: !e || !a
      ? 'A/E results missing (hosted arm optional)'
      : !eEvaluable
        ? `E ${coverageNote(a, e)}`
        : comparableLocals.length === 0
          ? localsUnusable
            ? `local arms present but ${coverageNote(a, ...localArms)} — "local arms well behind" not established`
            : 'no comparable local-arm results — "local arms well behind" not established'
          : `E ${(e.solvedRate * 100).toFixed(0)}% vs A ${(a.solvedRate * 100).toFixed(0)}%; best local within 5 points: ${localWithin ? 'yes' : 'no'}`,
  });

  const cheaper = [byId.get('B'), c1, c2, d, e].filter(Boolean) as ArmSummary[];
  // "Every cheaper arm well behind" needs every cheaper arm in the session to
  // be comparable evidence — one mid-batch arm must not let the claim fire.
  const cheaperAllComparable = cheaper.length > 0 && cheaper.every((arm) => comparable(a, arm));
  const allBehind = a !== undefined
    && cheaperAllComparable
    && cheaper.every((s) => a.solvedRate - s.solvedRate > CLOSE_MARGIN_POINTS / 100);
  outcomes.push({
    rule: 'every cheaper arm well behind A: keep the subscriptions; local models stay on helper tasks',
    triggered: allBehind,
    detail: cheaper.length === 0
      ? 'no cheaper-arm results'
      : !cheaperAllComparable
        ? `cheaper arms present but ${coverageNote(a, ...cheaper)}`
        : cheaper.map((s) => `${s.armId} ${(s.solvedRate * 100).toFixed(0)}%`).join(', '),
  });

  return outcomes;
}

export function summarizeArmStats(report: Pick<BenchmarkReport, 'arms'>): string {
  return report.arms
    .map((s) => `${s.armId}: ${s.solved}/${s.runs} solved`)
    .join('; ');
}

export { CLOSE_MARGIN_POINTS, PILOT_STOP_MARGIN_POINTS, C2_CLEAR_MARGIN_POINTS, LOCAL_TOKEN_SAVING_REQUIRED };
