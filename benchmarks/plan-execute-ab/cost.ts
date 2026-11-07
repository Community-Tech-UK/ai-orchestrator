/**
 * Metered cost accounting for the benchmark report (plan step 13: "cost per
 * solved task"). The only billed figure trusted here is the CLI's own
 * `total_cost_usd` from `result` events — the same source the plan's spend
 * notes are measured from. Local coders and Codex produce no metered USD cost
 * (the local CLI logs a nominal estimate that is never billed; Codex draws on
 * ChatGPT plan limits), so their cost is $0 plus, for the plan arms, the Opus
 * planner cost of the tasks they ran.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ARMS, coderIsClaudeBilled } from './arms';
import { isSolved } from './scorer';
import type { ArmCostSummary, ArmId, CostEvidence, CostReport, RunRecord } from './types';

/** `agent-cli.ts` writes one banner line before each CLI invocation. */
const INVOCATION_BANNER_PREFIX = '=== ';

const RUN_LOG = /^(.+)-([A-Z0-9]+)-run(\d+)\.(agent|takeover)\.log$/;
const PLANNER_LOG = /^(.+)\.planner\.log$/;
const CLAUDE_JUDGE_LOG = /-claude-\d+\.log$/;

/**
 * Metered USD spent per an agent log. Claude Code's `result` events carry
 * `total_cost_usd` CUMULATIVE for the invocation's session — it re-emits a
 * result at segment closes (values are non-decreasing, and exact duplicate
 * lines appear) — so one invocation costs its largest result figure, not the
 * sum of them. A log that appended several invocations (the runner opens logs
 * append-only) costs the sum across those. Tool results and `user` events that
 * merely echo the field are ignored.
 */
export function parseLogCostUsd(text: string): number {
  let total = 0;
  let current: number | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith(INVOCATION_BANNER_PREFIX)) {
      if (current !== null) total += current;
      current = null;
      continue;
    }
    if (!line.startsWith('{') || !line.includes('total_cost_usd')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event['type'] !== 'result') continue;
    const cost = event['total_cost_usd'];
    if (typeof cost === 'number' && Number.isFinite(cost) && (current === null || cost > current)) {
      current = cost;
    }
  }
  if (current !== null) total += current;
  return total;
}

function readCost(path: string): number {
  try {
    return parseLogCostUsd(readFileSync(path, 'utf8'));
  } catch {
    return 0;
  }
}

/** Read every metered-cost figure a session's logs hold. Missing pieces stay 0. */
export function readCostEvidence(sessionDir: string): CostEvidence {
  const evidence: CostEvidence = {
    coderUsdByRun: {},
    takeoverUsdByRun: {},
    plannerUsdByTask: {},
    judgeMeteredUsd: 0,
  };
  if (!existsSync(sessionDir)) return evidence;
  for (const name of readdirSync(sessionDir)) {
    const runLog = RUN_LOG.exec(name);
    if (runLog && runLog[2] in ARMS) {
      const key = `${runLog[1]}|${runLog[2]}|${runLog[3]}`;
      const usd = readCost(join(sessionDir, name));
      const target = runLog[4] === 'takeover' ? evidence.takeoverUsdByRun : evidence.coderUsdByRun;
      target[key] = (target[key] ?? 0) + usd;
    }
  }
  const plansDir = join(sessionDir, 'plans');
  if (existsSync(plansDir)) {
    for (const name of readdirSync(plansDir)) {
      const plannerLog = PLANNER_LOG.exec(name);
      if (plannerLog) {
        evidence.plannerUsdByTask[plannerLog[1]] = readCost(join(plansDir, name));
      }
    }
  }
  const judgeDir = join(sessionDir, 'judge');
  if (existsSync(judgeDir)) {
    for (const name of readdirSync(judgeDir)) {
      if (CLAUDE_JUDGE_LOG.test(name)) {
        evidence.judgeMeteredUsd += readCost(join(judgeDir, name));
      }
    }
  }
  return evidence;
}

function sumForArm(entries: Record<string, number>, armId: ArmId): number {
  let total = 0;
  for (const [key, usd] of Object.entries(entries)) {
    if (key.split('|')[1] === armId) total += usd;
  }
  return total;
}

function armNotes(armId: ArmId, takeoverUsd: number): string[] {
  const arm = ARMS[armId];
  const notes: string[] = [];
  if (arm.coderKind === 'local-claude-code') {
    notes.push('local coder: no metered cost (its logs hold a nominal CLI estimate that is never billed)');
  } else if (arm.coderKind === 'codex') {
    notes.push('Codex runs on ChatGPT plan limits: no metered USD cost');
  } else if (!coderIsClaudeBilled(armId)) {
    notes.push('hosted coder bills at the provider plan/rates: no metered USD cost here');
  }
  if (arm.usesFrozenPlan) {
    notes.push('includes the Opus planner cost of its tasks (one planner run per task, shared with every plan arm and counted in full, so cost per solved is this workflow standalone)');
  }
  if (takeoverUsd > 0) notes.push('includes Opus takeover cost');
  return notes;
}

/** Per-arm metered cost and "cost per solved task" (plan step 13). */
export function summarizeCosts(evidence: CostEvidence, runs: RunRecord[]): CostReport {
  const armIds = [...new Set(runs.map((run) => run.armId))];
  const arms: ArmCostSummary[] = armIds.map((armId) => {
    const armRuns = runs.filter((run) => run.armId === armId);
    const coderMeteredUsd = coderIsClaudeBilled(armId) ? sumForArm(evidence.coderUsdByRun, armId) : 0;
    const takeoverMeteredUsd = sumForArm(evidence.takeoverUsdByRun, armId);
    let plannerMeteredUsd = 0;
    if (ARMS[armId].usesFrozenPlan) {
      for (const taskId of new Set(armRuns.map((run) => run.taskId))) {
        plannerMeteredUsd += evidence.plannerUsdByTask[taskId] ?? 0;
      }
    }
    const solved = armRuns.filter((run) => isSolved(run.score)).length;
    const totalMeteredUsd = coderMeteredUsd + plannerMeteredUsd + takeoverMeteredUsd;
    return {
      armId,
      coderMeteredUsd,
      plannerMeteredUsd,
      takeoverMeteredUsd,
      totalMeteredUsd,
      solved,
      costPerSolvedUsd: solved > 0 ? totalMeteredUsd / solved : null,
      notes: armNotes(armId, takeoverMeteredUsd),
    };
  });

  const plannerMeteredUsd = Object.values(evidence.plannerUsdByTask).reduce((sum, usd) => sum + usd, 0);
  return {
    arms,
    plannerMeteredUsd,
    judgeMeteredUsd: evidence.judgeMeteredUsd,
    notes: [
      'Figures are the CLI-reported total_cost_usd per invocation (what Anthropic billed).',
      'Plan cost is shared: one Opus planner run per task feeds every plan arm, and each arm is charged its tasks\' plans in full — summing arm totals double-counts plans.',
      'Spend includes runs later quarantined: the money was spent either way.',
    ],
  };
}
