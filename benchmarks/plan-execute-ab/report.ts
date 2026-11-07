import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { coderIsClaudeBilled, coderIsLocalModel } from './arms';
import { summarizeCosts } from './cost';
import { evaluateDecisionRules } from './decision-rules';
import { isSolved } from './scorer';
import { reconcileRunRecords } from './session';
import { newcombeDifferenceInterval, wilsonInterval } from './stats';
import type {
  ArmId,
  ArmSpeedSummary,
  ArmSummary,
  BaselineGap,
  BenchmarkReport,
  CostEvidence,
  CostReport,
  JudgePairResult,
  RunRecord,
  SpeedGateDecision,
  SpeedGateRecord,
  TokenUsage,
} from './types';

export function summarizeArm(armId: ArmId, allRuns: RunRecord[], pairs: JudgePairResult[]): ArmSummary {
  // One record per run cell everywhere: duplicated records of a slot are
  // reconciled away before any counting (see reconcileRunRecords).
  const runs = reconcileRunRecords(allRuns).records;
  const solved = runs.filter((run) => isSolved(run.score)).length;
  const hiddenPass = runs.filter((run) => run.score?.hiddenTests.passed).length;
  const damageClean = runs.filter((run) => run.score?.damageOk).length;
  const armPairs = pairs.filter((pair) => pair.armId === armId);
  const count = (verdict: JudgePairResult['verdict']): number =>
    armPairs.filter((pair) => pair.verdict === verdict).length;

  // Uncertainty ranges use the task as the unit: repeat runs of one task are
  // not independent evidence (plan: full run "compared task by task"; honest
  // limits quote task counts). With one run per task this is textbook Wilson.
  const tasks = new Set(runs.map((run) => run.taskId)).size;
  const solvedRate = runs.length > 0 ? solved / runs.length : 0;
  const hiddenRate = runs.length > 0 ? hiddenPass / runs.length : 0;
  const solvedRateCI95 = wilsonInterval(solvedRate * tasks, tasks);
  const hiddenTestPassRateCI95 = wilsonInterval(hiddenRate * tasks, tasks);

  const speedSamples = runs.flatMap((run) => (run.localSpeed ? [run.localSpeed] : []));
  const measured = speedSamples.filter(
    (sample) => sample.source !== 'unmeasured' && sample.promptTokensPerSec !== null && sample.writeTokensPerSec !== null,
  );
  const localSpeed: ArmSpeedSummary | undefined = speedSamples.length > 0
    ? {
        measuredRuns: measured.length,
        unmeasuredRuns: speedSamples.length - measured.length,
        avgPromptTokensPerSec: measured.length > 0
          ? measured.reduce((sum, sample) => sum + (sample.promptTokensPerSec ?? 0), 0) / measured.length
          : null,
        avgWriteTokensPerSec: measured.length > 0
          ? measured.reduce((sum, sample) => sum + (sample.writeTokensPerSec ?? 0), 0) / measured.length
          : null,
      }
    : undefined;

  const totalDuration = runs.reduce((sum, run) => sum + run.durationMs, 0);
  const totalOutput = runs.reduce((sum, run) => sum + run.coderUsage.outputTokens + run.takeoverUsage.outputTokens, 0);
  // Claude vs local token accounting (plan: "Claude tokens (planner + coder +
  // takeover), local tokens"). Planner and takeover runs are always Opus; a
  // coder's tokens are Claude's only when Anthropic bills them (A/D) and the
  // local model's only for local coders (B/C1/C2/F).
  const countTokens = (usage: TokenUsage): number =>
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  // Serving-setup provenance (fairness control: "same model files, server
  // build and settings throughout; restart that arm" on change). Local runs
  // record their stack id; a mix inside one arm is detectable and disqualifies
  // the arm from comparisons until it is rerun under a single setup.
  const servingSetups = coderIsLocalModel(armId)
    ? [...new Set(runs.map((run) => run.servingSetupId ?? 'unrecorded'))].sort()
    : [];
  const coderClaudeBilled = coderIsClaudeBilled(armId);
  const coderLocalModel = coderIsLocalModel(armId);
  let claudeTotal = 0;
  let localTotal = 0;
  for (const run of runs) {
    claudeTotal += countTokens(run.plannerUsage) + countTokens(run.takeoverUsage);
    if (coderClaudeBilled) claudeTotal += countTokens(run.coderUsage);
    if (coderLocalModel) localTotal += countTokens(run.coderUsage);
  }

  return {
    armId,
    runs: runs.length,
    solved,
    solvedRate,
    hiddenTestPass: hiddenPass,
    damageClean,
    avgDurationMs: runs.length > 0 ? totalDuration / runs.length : 0,
    avgCoderOutputTokens: runs.length > 0 ? totalOutput / runs.length : 0,
    avgClaudeTokens: runs.length > 0 ? claudeTotal / runs.length : 0,
    avgLocalTokens: runs.length > 0 ? localTotal / runs.length : 0,
    judgeWins: count('arm-win'),
    judgeLosses: count('baseline-win'),
    judgeTies: count('tie'),
    judgeUnavailable: count('judge-unavailable'),
    failureModes: {
      looped: runs.filter((run) => run.flags.looped).length,
      toolCallErrors: runs.filter((run) => run.flags.toolCallErrors > 0).length,
      hitTurnCap: runs.filter((run) => run.flags.hitTurnCap).length,
      gaveUp: runs.filter((run) => run.flags.gaveUp).length,
      error: runs.filter((run) => run.error !== undefined).length,
    },
    localSpeed,
    tasks,
    solvedRateCI95,
    hiddenTestPassRateCI95,
    servingSetups,
    mixedServingSetup: servingSetups.length > 1,
  };
}

export function buildReport(
  sessionDir: string,
  runs: RunRecord[],
  pairs: JudgePairResult[],
  speedGate: SpeedGateDecision | null,
  phase: 'pilot' | 'full',
  notes: string[] = [],
  speedSamples: SpeedGateRecord[] = [],
  costEvidence: CostEvidence | null = null,
  expectedTaskIds?: readonly string[],
): BenchmarkReport {
  // One record per run cell before ANY aggregation or decision: duplicated
  // records of an existing slot must never count as extra evidence (see
  // reconcileRunRecords) — they can otherwise reverse a decision-rule verdict.
  const { records: cellRecords, duplicates } = reconcileRunRecords(runs);
  const reportNotes = duplicates > 0
    ? [...notes, `${duplicates} duplicate run record(s) ignored — one record per task/arm/run cell counts`]
    : notes;
  const armIds = [...new Set(cellRecords.map((run) => run.armId))];
  const arms = armIds.map((armId) => summarizeArm(armId, cellRecords.filter((run) => run.armId === armId), pairs));

  const baseline = arms.find((arm) => arm.armId === 'A');
  const baselineGaps: BaselineGap[] = baseline
    ? arms
      .filter((arm) => arm.armId !== 'A')
      .map((arm) => {
        const gap = arm.solvedRate - baseline.solvedRate;
        const ci = newcombeDifferenceInterval(arm.solvedRate, arm.solvedRateCI95, baseline.solvedRate, baseline.solvedRateCI95);
        return {
          armId: arm.armId,
          gapPoints: gap * 100,
          ci95Points: { low: ci.low * 100, high: ci.high * 100 },
          excludesZero: ci.low > 0 || ci.high < 0,
        };
      })
    : [];

  // Judge agreement counts task-arm PAIRS both judges answered — one available
  // verdict from Claude AND one from Codex on the same pair. Individual results
  // are not pairs (two results from one judge, or a lone judge, never make
  // "both judges answering"), and agreement is those pairs whose verdicts match.
  const byTaskArm = new Map<string, JudgePairResult[]>();
  for (const pair of pairs) {
    const key = `${pair.taskId}::${pair.armId}`;
    const list = byTaskArm.get(key) ?? [];
    list.push(pair);
    byTaskArm.set(key, list);
  }
  let bothCalled = 0;
  let sameVerdict = 0;
  for (const list of byTaskArm.values()) {
    const claude = list.find((p) => p.judge === 'claude' && p.verdict !== 'judge-unavailable');
    const codex = list.find((p) => p.judge === 'codex' && p.verdict !== 'judge-unavailable');
    if (!claude || !codex) continue;
    bothCalled += 1;
    if (claude.verdict === codex.verdict) sameVerdict += 1;
  }

  // "Conflicts with hidden tests" compares the judge's PREFERENCE with the
  // hidden-test verdict on the TWO patches actually judged — the arm's and arm
  // A's on the same task, each a specific run's patch (damage is a separate
  // metric, never smuggled in through isSolved). Tests passing or failing on
  // both sides express no preference, so a judge preferring either side cannot
  // conflict with them; preferring the side the tests mark worse does.
  // Never the majority of different repeat patches: the judged patch has ONE
  // outcome, identified by its run number (`subjectRunNumber`/`baselineRunNumber`
  // recorded at judging time). Pairs predating those fields are aligned with
  // the run `judgeSession` actually picked for them — the cell's first record.
  const runsByCell = new Map<string, RunRecord[]>();
  for (const run of cellRecords) {
    const key = `${run.taskId}::${run.armId}`;
    const list = runsByCell.get(key) ?? [];
    list.push(run);
    runsByCell.set(key, list);
  }
  const judgedRunOutcome = (taskId: string, armId: ArmId, runNumber?: number): 'pass' | 'fail' | 'unknown' => {
    const cell = runsByCell.get(`${taskId}::${armId}`) ?? [];
    const run = runNumber === undefined ? cell[0] : cell.find((entry) => entry.runNumber === runNumber);
    if (!run || run.score === undefined) return 'unknown';
    return run.score.hiddenTests.passed ? 'pass' : 'fail';
  };
  let conflictsWithHiddenTests = 0;
  for (const pair of pairs) {
    if (pair.verdict === 'judge-unavailable' || pair.verdict === 'tie') continue;
    const subject = judgedRunOutcome(pair.taskId, pair.armId, pair.subjectRunNumber);
    const baseline = judgedRunOutcome(pair.taskId, 'A', pair.baselineRunNumber);
    if (subject === 'unknown' || baseline === 'unknown' || subject === baseline) continue;
    const testsPreferArm = subject === 'pass';
    if ((pair.verdict === 'arm-win') !== testsPreferArm) conflictsWithHiddenTests += 1;
  }

  return {
    sessionDir,
    createdAt: new Date().toISOString(),
    arms,
    judgeAgreement: {
      bothJudgesCalled: bothCalled,
      sameVerdict,
      conflictsWithHiddenTests,
    },
    speedGate,
    speedSamples,
    baselineGaps,
    cost: costEvidence ? summarizeCosts(costEvidence, cellRecords) : null,
    decisionRules: evaluateDecisionRules(arms, speedGate, phase,
      Object.fromEntries(armIds.map((id) => [id, cellRecords.filter((run) => run.armId === id)
        .map((run) => ({ taskId: run.taskId, runNumber: run.runNumber }))])),
      expectedTaskIds),
    notes: reportNotes,
  };
}

function minutes(ms: number): string {
  return `${(ms / 60_000).toFixed(1)} min`;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function points(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}

function renderUncertainty(report: BenchmarkReport): string[] {
  const lines: string[] = [];
  lines.push('## Uncertainty (95% ranges)');
  lines.push('');
  lines.push(
    'The task is the unit: repeat runs of one task are not independent evidence, so ranges are '
    + 'Wilson score intervals over tasks. Overlapping ranges mean a gap can be noise — the plan\'s '
    + 'honest limits: 30 tasks can only show large differences, roughly 15–20 points.',
  );
  lines.push('');
  lines.push('| Arm | Solved | 95% range | Hidden tests pass | 95% range |');
  lines.push('|---|---|---|---|---|');
  for (const arm of report.arms) {
    lines.push(
      `| ${arm.armId} | ${pct(arm.solvedRate)} | ${pct(arm.solvedRateCI95.low)}–${pct(arm.solvedRateCI95.high)} `
      + `| ${pct(arm.runs > 0 ? arm.hiddenTestPass / arm.runs : 0)} `
      + `| ${pct(arm.hiddenTestPassRateCI95.low)}–${pct(arm.hiddenTestPassRateCI95.high)} |`,
    );
  }
  if (report.baselineGaps.length > 0) {
    lines.push('');
    lines.push('### Solved-rate gap vs arm A (percentage points)');
    lines.push('');
    lines.push('| Arm | Gap vs A | 95% range | Reading |');
    lines.push('|---|---|---|---|');
    for (const gap of report.baselineGaps) {
      const reading = gap.excludesZero
        ? 'gap is bigger than noise at this size'
        : 'can be noise at this size';
      lines.push(
        `| ${gap.armId} | ${points(gap.gapPoints)} | ${points(gap.ci95Points.low)} to ${points(gap.ci95Points.high)} | ${reading} |`,
      );
    }
    lines.push('');
    lines.push(
      "Gaps use Newcombe's interval for two proportions. The arms share tasks, so a paired "
      + 'interval would be tighter when outcomes move together; this form is the conservative side.',
    );
  } else {
    lines.push('');
    lines.push('Arm A has no runs in this session, so no gap vs baseline can be computed.');
  }
  return lines;
}

function renderCost(report: BenchmarkReport): string[] {
  const lines: string[] = [];
  lines.push('## Cost (metered USD)');
  lines.push('');
  const cost: CostReport | null = report.cost;
  if (!cost) {
    lines.push('Cost evidence was not collected for this session.');
    return lines;
  }
  lines.push('| Arm | Coder | Plans | Takeover | Total | Solved | Cost per solved |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const arm of cost.arms) {
    const coder = arm.coderMeteredUsd > 0 ? usd(arm.coderMeteredUsd) : '—';
    const plans = arm.plannerMeteredUsd > 0 ? usd(arm.plannerMeteredUsd) : '—';
    const takeover = arm.takeoverMeteredUsd > 0 ? usd(arm.takeoverMeteredUsd) : '—';
    const perSolved = arm.costPerSolvedUsd === null ? '—' : usd(arm.costPerSolvedUsd);
    lines.push(
      `| ${arm.armId} | ${coder} | ${plans} | ${takeover} | ${usd(arm.totalMeteredUsd)} | ${arm.solved} | ${perSolved} |`,
    );
  }
  lines.push('');
  lines.push(`- Shared Opus planners: ${usd(cost.plannerMeteredUsd)} across the session's planned tasks.`);
  lines.push(`- Shared Claude judging: ${usd(cost.judgeMeteredUsd)} (Codex judging runs on ChatGPT plan limits — no metered cost).`);
  for (const arm of cost.arms) {
    for (const note of arm.notes) lines.push(`- ${arm.armId}: ${note}`);
  }
  for (const note of cost.notes) lines.push(`- ${note}`);
  return lines;
}

export function renderReportMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push('# plan/execute A-B benchmark report');
  lines.push('');
  lines.push(`Session: ${report.sessionDir}`);
  lines.push(`Created: ${report.createdAt}`);
  lines.push('');
  lines.push('## Results per arm');
  lines.push('');
  lines.push('| Arm | Runs | Hidden tests pass | Solved (tests + no damage) | Solved % (95% range) | Avg time | Avg output tokens | Avg Claude tokens | Avg local tokens | Judge W/L/T |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const arm of report.arms) {
    lines.push(
      `| ${arm.armId} | ${arm.runs} | ${arm.hiddenTestPass} | ${arm.solved} `
      + `| ${pct(arm.solvedRate)} (${pct(arm.solvedRateCI95.low)}–${pct(arm.solvedRateCI95.high)}) `
      + `| ${minutes(arm.avgDurationMs)} | ${Math.round(arm.avgCoderOutputTokens)} `
      + `| ${Math.round(arm.avgClaudeTokens)} | ${Math.round(arm.avgLocalTokens)} `
      + `| ${arm.judgeWins}/${arm.judgeLosses}/${arm.judgeTies} |`,
    );
  }
  lines.push('');
  lines.push(
    'Claude tokens are the volume Opus/Sonnet processed (planner + Claude-billed coder + takeover, '
    + 'including cache reads/writes); local tokens are the local model\'s coder volume. '
    + 'Hosted-GLM and Codex coder tokens appear in neither column.',
  );
  const armsWithSetups = report.arms.filter((arm) => arm.servingSetups.length > 0);
  if (armsWithSetups.length > 0) {
    lines.push('');
    lines.push('## Serving setups (fairness control)');
    lines.push('');
    for (const arm of armsWithSetups) {
      lines.push(
        `- ${arm.armId}: ${arm.servingSetups.join(', ')}`
        + (arm.mixedServingSetup
          ? ' — MIXED: the fairness control requires one server/settings setup per arm (restart the arm on change), so this arm’s combined results are not valid evidence and every rule involving it is withheld'
          : ''),
      );
    }
  }
  lines.push('');
  lines.push(...renderUncertainty(report));
  lines.push('');
  lines.push(...renderCost(report));
  lines.push('');
  lines.push('## Failure modes');
  lines.push('');
  lines.push('| Arm | Looped | Tool-call errors | Hit turn cap | Gave up | Run errors |');
  lines.push('|---|---|---|---|---|---|');
  for (const arm of report.arms) {
    const f = arm.failureModes;
    lines.push(`| ${arm.armId} | ${f.looped} | ${f.toolCallErrors} | ${f.hitTurnCap} | ${f.gaveUp} | ${f.error} |`);
  }
  lines.push('');
  lines.push('## Judges');
  lines.push('');
  lines.push(`- Judge pairs with both judges answering: ${report.judgeAgreement.bothJudgesCalled}`);
  lines.push(`- Pairs where both judges gave the same verdict: ${report.judgeAgreement.sameVerdict}`);
  lines.push(`- Judge verdicts that conflict with hidden tests: ${report.judgeAgreement.conflictsWithHiddenTests} (tests never overridden)`);
  lines.push('');
  lines.push('## Local model speeds');
  lines.push('');
  if (report.speedSamples.length > 0) {
    lines.push('| Model | Measured at | Prompt tok/s | Write tok/s | Source | Gate |');
    lines.push('|---|---|---|---|---|---|');
    for (const entry of report.speedSamples) {
      const gate = entry.decision
        ? (entry.decision.keepC2 ? 'PASS (keep C2)' : 'FAIL (drop C2)')
        : 'n/a';
      lines.push(
        `| ${entry.modelKey} | ${entry.measuredAt} | ${entry.sample.promptTokensPerSec.toFixed(0)} | `
        + `${entry.sample.writeTokensPerSec.toFixed(1)} | ${entry.sample.source ?? 'unknown'} | ${gate} |`,
      );
    }
    lines.push('');
  }
  lines.push(
    `- Speed gate (C2 / Flash-Next): ${
      report.speedGate
        ? `${report.speedGate.keepC2 ? 'PASS — keep C2' : 'FAIL — drop C2'} — ${report.speedGate.reasons.join('; ')}`
        : 'not measured in this session'
    }`,
  );
  const armsWithSpeed = report.arms.filter((arm) => arm.localSpeed !== undefined);
  if (armsWithSpeed.length > 0) {
    lines.push('');
    lines.push('### Per-run probe speeds');
    lines.push('');
    lines.push('| Arm | Measured runs | Unmeasured runs | Avg prompt tok/s | Avg write tok/s |');
    lines.push('|---|---|---|---|---|');
    for (const arm of armsWithSpeed) {
      const speed = arm.localSpeed;
      if (!speed) continue;
      const prompt = speed.avgPromptTokensPerSec === null ? '—' : speed.avgPromptTokensPerSec.toFixed(0);
      const write = speed.avgWriteTokensPerSec === null ? '—' : speed.avgWriteTokensPerSec.toFixed(1);
      lines.push(`| ${arm.armId} | ${speed.measuredRuns} | ${speed.unmeasuredRuns} | ${prompt} | ${write} |`);
    }
  }
  lines.push('');
  lines.push('## Pre-agreed decision rules');
  lines.push('');
  for (const rule of report.decisionRules) {
    lines.push(`- [${rule.triggered ? 'TRIGGERED' : 'not triggered'}] ${rule.rule}`);
    lines.push(`  - ${rule.detail}`);
  }
  if (report.notes.length > 0) {
    lines.push('');
    lines.push('## Notes');
    lines.push('');
    for (const note of report.notes) lines.push(`- ${note}`);
  }
  return lines.join('\n');
}

export function writeReport(sessionDir: string, report: BenchmarkReport): { jsonPath: string; mdPath: string } {
  mkdirSync(sessionDir, { recursive: true });
  const jsonPath = join(sessionDir, 'report.json');
  const mdPath = join(sessionDir, 'report.md');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, renderReportMarkdown(report));
  return { jsonPath, mdPath };
}
