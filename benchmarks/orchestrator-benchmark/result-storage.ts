/**
 * Result Storage - Persists benchmark results to disk
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { niahScoreToCorrectness } from './scorer.js';
import type {
  BenchmarkRun,
  BenchmarkTask,
  TaskResult,
  BenchmarkReport,
  ContextStage,
  SystemType,
  TokenUsageBreakdown,
  TokenEfficiency,
} from './types.js';

const RESULTS_DIR = join(import.meta.dirname, 'results');

/**
 * Ensure results directory exists
 */
function ensureResultsDir(): void {
  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true });
  }
}

/**
 * Generate a unique benchmark session ID
 */
export function generateSessionId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19).replace(/:/g, '-');
  return `benchmark-${date}-${time}`;
}

/**
 * Get the path for a session's results
 */
function getSessionPath(sessionId: string): string {
  return join(RESULTS_DIR, `${sessionId}.json`);
}

/**
 * Session data structure stored on disk
 */
interface SessionData {
  sessionId: string;
  startedAt: number;
  completedAt?: number;
  runs: BenchmarkRun[];
  tasks: BenchmarkTask[];
}

/**
 * Initialize a new benchmark session
 */
export function initSession(sessionId: string, tasks: BenchmarkTask[]): void {
  ensureResultsDir();

  const session: SessionData = {
    sessionId,
    startedAt: Date.now(),
    runs: [],
    tasks,
  };

  writeFileSync(getSessionPath(sessionId), JSON.stringify(session, null, 2));
}

/**
 * Load an existing session
 */
export function loadSession(sessionId: string): SessionData | null {
  const path = getSessionPath(sessionId);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content) as SessionData;
  } catch {
    return null;
  }
}

/**
 * Save a benchmark run result
 */
export function saveRun(sessionId: string, run: BenchmarkRun): void {
  const session = loadSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  // Check if this run already exists (re-run scenario)
  const existingIndex = session.runs.findIndex(
    r =>
      r.taskId === run.taskId &&
      r.system === run.system &&
      r.contextStage === run.contextStage &&
      r.runNumber === run.runNumber
  );

  if (existingIndex >= 0) {
    session.runs[existingIndex] = run;
  } else {
    session.runs.push(run);
  }

  writeFileSync(getSessionPath(sessionId), JSON.stringify(session, null, 2));
}

/**
 * Mark session as complete
 */
export function completeSession(sessionId: string): void {
  const session = loadSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  session.completedAt = Date.now();
  writeFileSync(getSessionPath(sessionId), JSON.stringify(session, null, 2));
}

/**
 * Get all runs for a specific task
 */
export function getRunsForTask(sessionId: string, taskId: string): BenchmarkRun[] {
  const session = loadSession(sessionId);
  if (!session) return [];

  return session.runs.filter(r => r.taskId === taskId);
}

/**
 * Get runs filtered by system and context stage
 */
export function getRuns(
  sessionId: string,
  taskId: string,
  system: SystemType,
  contextStage: ContextStage
): BenchmarkRun[] {
  const session = loadSession(sessionId);
  if (!session) return [];

  return session.runs.filter(
    r =>
      r.taskId === taskId &&
      r.system === system &&
      r.contextStage === contextStage
  );
}

/**
 * Check if a specific run has been completed
 */
export function isRunComplete(
  sessionId: string,
  taskId: string,
  system: SystemType,
  contextStage: ContextStage,
  runNumber: 1 | 2 | 3
): boolean {
  const session = loadSession(sessionId);
  if (!session) return false;

  return session.runs.some(
    r =>
      r.taskId === taskId &&
      r.system === system &&
      r.contextStage === contextStage &&
      r.runNumber === runNumber &&
      !r.error
  );
}

/**
 * Extract a 0-100 score from a benchmark run regardless of task type.
 */
function extractRunScore(r: BenchmarkRun): number {
  if (r.knownAnswerScore) {
    return r.knownAnswerScore.correctness;
  }
  if (r.niahScore) {
    return niahScoreToCorrectness(r.niahScore);
  }
  if (r.judgeScores) {
    const claude = r.judgeScores.claude;
    const codex = r.judgeScores.codex;
    const claudeAvg = (claude.completeness + claude.accuracy + claude.actionability) / 3;
    const codexAvg = (codex.completeness + codex.accuracy + codex.actionability) / 3;
    return ((claudeAvg + codexAvg) / 2) * 10; // Scale to 0-100
  }
  return 0;
}

/**
 * Calculate median score from runs
 */
function medianScore(runs: BenchmarkRun[]): number {
  if (runs.length === 0) return 0;

  const scores = runs
    .map(extractRunScore)
    .sort((a, b) => a - b);

  const mid = Math.floor(scores.length / 2);
  return scores.length % 2 !== 0
    ? scores[mid]
    : (scores[mid - 1] + scores[mid]) / 2;
}

/**
 * Aggregate token breakdowns from a set of runs.
 */
function aggregateTokenBreakdown(runs: BenchmarkRun[]): TokenUsageBreakdown {
  const result: TokenUsageBreakdown = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  for (const r of runs) {
    if (r.tokenBreakdown) {
      result.inputTokens += r.tokenBreakdown.inputTokens;
      result.outputTokens += r.tokenBreakdown.outputTokens;
      result.cacheReadTokens += r.tokenBreakdown.cacheReadTokens;
      result.cacheWriteTokens += r.tokenBreakdown.cacheWriteTokens;
    }
  }
  return result;
}

/**
 * Calculate token efficiency for a set of runs.
 */
function calculateTokenEfficiency(
  runs: BenchmarkRun[],
  avgScore: number,
  baselineTokens?: number
): TokenEfficiency {
  const totalTokens = runs.reduce((sum, r) => sum + r.tokensUsed, 0);
  const avgTokens = runs.length > 0 ? totalTokens / runs.length : 0;
  const tokensPerCorrectPoint = avgScore > 0 ? avgTokens / avgScore : 0;
  const costMultiplier = baselineTokens && baselineTokens > 0
    ? avgTokens / baselineTokens
    : 1;

  return {
    tokensPerCorrectPoint: Math.round(tokensPerCorrectPoint),
    costMultiplier: Math.round(costMultiplier * 100) / 100,
  };
}

/**
 * Generate a task result from runs
 */
export function generateTaskResult(
  sessionId: string,
  task: BenchmarkTask
): TaskResult | null {
  const session = loadSession(sessionId);
  if (!session) return null;

  const taskRuns = session.runs.filter(r => r.taskId === task.id);
  if (taskRuns.length === 0) return null;

  const stages: ContextStage[] = ['fresh', 'moderate', 'heavy'];
  const systems: SystemType[] = ['vanilla', 'orchestrator'];

  // Calculate median scores for each system and stage
  const medianScores = {
    vanilla: { fresh: 0, moderate: 0, heavy: 0 },
    orchestrator: { fresh: 0, moderate: 0, heavy: 0 },
  };

  for (const system of systems) {
    for (const stage of stages) {
      const runs = taskRuns.filter(r => r.system === system && r.contextStage === stage);
      medianScores[system][stage] = medianScore(runs);
    }
  }

  // Calculate overall scores (average across stages)
  const vanillaOverall =
    (medianScores.vanilla.fresh + medianScores.vanilla.moderate + medianScores.vanilla.heavy) / 3;
  const orchestratorOverall =
    (medianScores.orchestrator.fresh +
      medianScores.orchestrator.moderate +
      medianScores.orchestrator.heavy) /
    3;

  // Determine winner
  let winner: 'vanilla' | 'orchestrator' | 'tie';
  const diff = orchestratorOverall - vanillaOverall;
  if (Math.abs(diff) < 5) {
    winner = 'tie';
  } else {
    winner = diff > 0 ? 'orchestrator' : 'vanilla';
  }

  // Calculate cost ratio
  const vanillaTokens = taskRuns
    .filter(r => r.system === 'vanilla')
    .reduce((sum, r) => sum + r.tokensUsed, 0);
  const orchestratorTokens = taskRuns
    .filter(r => r.system === 'orchestrator')
    .reduce((sum, r) => sum + r.tokensUsed, 0);
  const costRatio = vanillaTokens > 0 ? orchestratorTokens / vanillaTokens : 1;

  // Calculate context resilience
  const vanillaResilience =
    medianScores.vanilla.fresh > 0
      ? medianScores.vanilla.heavy / medianScores.vanilla.fresh
      : 0;
  const orchestratorResilience =
    medianScores.orchestrator.fresh > 0
      ? medianScores.orchestrator.heavy / medianScores.orchestrator.fresh
      : 0;

  // Calculate token efficiency
  const vanillaRuns = taskRuns.filter(r => r.system === 'vanilla');
  const orchestratorRuns = taskRuns.filter(r => r.system === 'orchestrator');
  const vanillaAvgTokens = vanillaRuns.length > 0
    ? vanillaRuns.reduce((s, r) => s + r.tokensUsed, 0) / vanillaRuns.length
    : 0;

  const vanillaEfficiency = calculateTokenEfficiency(vanillaRuns, vanillaOverall);
  const orchestratorEfficiency = calculateTokenEfficiency(
    orchestratorRuns,
    orchestratorOverall,
    vanillaAvgTokens
  );

  return {
    taskId: task.id,
    task,
    runs: taskRuns,
    medianScores,
    winner,
    costRatio,
    contextResilience: {
      vanilla: vanillaResilience,
      orchestrator: orchestratorResilience,
    },
    tokenEfficiency: {
      vanilla: vanillaEfficiency,
      orchestrator: orchestratorEfficiency,
    },
  };
}

/**
 * Generate the full benchmark report
 */
export function generateReport(sessionId: string): BenchmarkReport | null {
  const session = loadSession(sessionId);
  if (!session) return null;

  const taskResults: TaskResult[] = [];
  for (const task of session.tasks) {
    const result = generateTaskResult(sessionId, task);
    if (result) {
      taskResults.push(result);
    }
  }

  if (taskResults.length === 0) {
    return null;
  }

  // Calculate summary statistics
  let orchestratorWins = 0;
  let vanillaWins = 0;
  let ties = 0;
  let totalCostRatio = 0;
  let totalVanillaResilience = 0;
  let totalOrchestratorResilience = 0;
  let totalVanillaTPC = 0;
  let totalOrchestratorTPC = 0;

  for (const result of taskResults) {
    if (result.winner === 'orchestrator') orchestratorWins++;
    else if (result.winner === 'vanilla') vanillaWins++;
    else ties++;

    totalCostRatio += result.costRatio;
    totalVanillaResilience += result.contextResilience.vanilla;
    totalOrchestratorResilience += result.contextResilience.orchestrator;

    if (result.tokenEfficiency) {
      totalVanillaTPC += result.tokenEfficiency.vanilla.tokensPerCorrectPoint;
      totalOrchestratorTPC += result.tokenEfficiency.orchestrator.tokensPerCorrectPoint;
    }
  }

  const count = taskResults.length;

  // Aggregate token breakdowns across all runs
  const allRuns = session.runs;
  const vanillaBreakdown = aggregateTokenBreakdown(
    allRuns.filter(r => r.system === 'vanilla')
  );
  const orchestratorBreakdown = aggregateTokenBreakdown(
    allRuns.filter(r => r.system === 'orchestrator')
  );

  // Calculate by complexity
  const complexities: Array<'single-file' | 'multi-file' | 'large-context'> = [
    'single-file',
    'multi-file',
    'large-context',
  ];

  const byComplexity: BenchmarkReport['byComplexity'] = {
    'single-file': { orchestratorAvgScore: 0, vanillaAvgScore: 0 },
    'multi-file': { orchestratorAvgScore: 0, vanillaAvgScore: 0 },
    'large-context': { orchestratorAvgScore: 0, vanillaAvgScore: 0 },
  };

  for (const complexity of complexities) {
    const results = taskResults.filter(r => r.task.complexity === complexity);
    if (results.length > 0) {
      const orchScores = results.map(
        r =>
          (r.medianScores.orchestrator.fresh +
            r.medianScores.orchestrator.moderate +
            r.medianScores.orchestrator.heavy) /
          3
      );
      const vanScores = results.map(
        r =>
          (r.medianScores.vanilla.fresh +
            r.medianScores.vanilla.moderate +
            r.medianScores.vanilla.heavy) /
          3
      );

      byComplexity[complexity] = {
        orchestratorAvgScore: orchScores.reduce((a, b) => a + b, 0) / orchScores.length,
        vanillaAvgScore: vanScores.reduce((a, b) => a + b, 0) / vanScores.length,
      };
    }
  }

  const hasBreakdowns = vanillaBreakdown.inputTokens > 0 || orchestratorBreakdown.inputTokens > 0;

  return {
    startedAt: session.startedAt,
    completedAt: session.completedAt || Date.now(),
    tasks: taskResults,
    summary: {
      orchestratorWins,
      vanillaWins,
      ties,
      avgCostRatio: totalCostRatio / count,
      avgContextResilienceVanilla: totalVanillaResilience / count,
      avgContextResilienceOrchestrator: totalOrchestratorResilience / count,
      avgTokensPerCorrectVanilla: Math.round(totalVanillaTPC / count),
      avgTokensPerCorrectOrchestrator: Math.round(totalOrchestratorTPC / count),
      totalTokenBreakdown: hasBreakdowns
        ? { vanilla: vanillaBreakdown, orchestrator: orchestratorBreakdown }
        : undefined,
    },
    byComplexity,
  };
}

/**
 * Save report to a separate file
 */
export function saveReport(sessionId: string, report: BenchmarkReport): void {
  ensureResultsDir();
  const reportPath = join(RESULTS_DIR, `${sessionId}-report.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

/**
 * List all benchmark sessions
 */
export function listSessions(): string[] {
  ensureResultsDir();

  try {
    const files = require('fs').readdirSync(RESULTS_DIR) as string[];
    return files
      .filter((f: string) => f.endsWith('.json') && !f.endsWith('-report.json'))
      .map((f: string) => f.replace('.json', ''));
  } catch {
    return [];
  }
}
