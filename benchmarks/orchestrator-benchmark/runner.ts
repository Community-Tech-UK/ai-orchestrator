#!/usr/bin/env npx ts-node

/**
 * Benchmark Runner - Main entry point for orchestrator vs vanilla benchmarks
 *
 * Usage:
 *   npx ts-node runner.ts                    # Run full benchmark suite
 *   npx ts-node runner.ts --task KA-1        # Run specific task
 *   npx ts-node runner.ts --resume <session> # Resume previous session
 *   npx ts-node runner.ts --report <session> # Generate report for session
 */

import { resolve, join } from 'path';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { loadTaskSuite, loadTask } from './task-loader.js';
import { executeVanilla } from './executors/vanilla-executor.js';
import { executeOrchestrator } from './executors/orchestrator-executor.js';
import { generateContext, contextMessagesToStrings } from './context-filler.js';
import {
  generateSessionId,
  initSession,
  saveRun,
  completeSession,
  isRunComplete,
  generateReport,
  saveReport,
  loadSession,
  getRuns,
} from './result-storage.js';
import { scoreKnownAnswer, hasGroundTruth, scoreNiah, niahScoreToCorrectness } from './scorer.js';
import { evaluateWithJudges, calculateAgreementStats } from './judge.js';
import type {
  BenchmarkTask,
  BenchmarkRun,
  ContextStage,
  SystemType,
  JudgeScores,
  QuickEvalConfig,
} from './types.js';

// Configuration
const RUNS_PER_CONFIG = 3;
const CONTEXT_STAGES: ContextStage[] = ['fresh', 'moderate', 'heavy'];
const SYSTEMS: SystemType[] = ['vanilla', 'orchestrator'];
const WORKTREE_BASE = '/tmp/bench-worktrees';

/**
 * Quick eval preset: covers each category (KA, NIAH, RC) with increasing
 * difficulty, using only fresh + heavy stages and 1 run per config.
 * Total: 6 tasks × 2 systems × 2 stages × 1 run = 24 runs (~30-45 min)
 */
const QUICK_EVAL: QuickEvalConfig = {
  taskIds: ['KA-1', 'KA-2', 'NIAH-1', 'NIAH-5', 'NIAH-9', 'RC-1'],
  stages: ['fresh', 'heavy'],
  runsPerConfig: 1,
};

interface RunnerOptions {
  taskId?: string;
  sessionId?: string;
  generateReportOnly?: boolean;
  skipVanilla?: boolean;
  skipOrchestrator?: boolean;
  dryRun?: boolean;
  skipScoring?: boolean;
  scoreOnly?: boolean;
  noIsolation?: boolean;
  quick?: boolean;
}

/**
 * Represents a single benchmark run configuration
 */
interface RunConfig {
  task: BenchmarkTask;
  system: SystemType;
  stage: ContextStage;
  runNumber: 1 | 2 | 3;
}

/**
 * Fisher-Yates shuffle for randomizing run order
 */
function shuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Generate all run configurations and randomize order
 */
function generateRunConfigs(
  tasks: BenchmarkTask[],
  systems: SystemType[],
  stages: ContextStage[] = CONTEXT_STAGES,
  runsPerConfig: number = RUNS_PER_CONFIG
): RunConfig[] {
  const configs: RunConfig[] = [];

  for (const task of tasks) {
    for (const system of systems) {
      for (const stage of stages) {
        for (let runNum = 1; runNum <= runsPerConfig; runNum++) {
          configs.push({
            task,
            system,
            stage,
            runNumber: runNum as 1 | 2 | 3,
          });
        }
      }
    }
  }

  // Randomize to reduce drift bias
  return shuffleArray(configs);
}

/**
 * Create an isolated git worktree for a benchmark run
 * Uses execSync with fixed commands (no user input) for git worktree operations
 */
function createWorktree(sessionId: string, runIndex: number): string {
  const worktreePath = join(WORKTREE_BASE, `${sessionId}-run${runIndex}`);

  // Ensure base directory exists
  if (!existsSync(WORKTREE_BASE)) {
    mkdirSync(WORKTREE_BASE, { recursive: true });
  }

  // Remove existing worktree if present
  if (existsSync(worktreePath)) {
    try {
      // Safe: worktreePath is constructed from sessionId (generated internally) and runIndex (number)
      execSync(`git worktree remove "${worktreePath}" --force`, { stdio: 'pipe' });
    } catch {
      // May not be a worktree, just remove directory
      rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  // Create new worktree
  try {
    // Safe: worktreePath is constructed from internal values only
    execSync(`git worktree add "${worktreePath}" HEAD --detach`, { stdio: 'pipe' });
    console.log(`  [ISOLATION] Created worktree: ${worktreePath}`);
    return worktreePath;
  } catch (err) {
    console.warn(`  [ISOLATION] Failed to create worktree, using fallback: ${err}`);
    return '';  // Empty string signals fallback needed
  }
}

/**
 * Remove a git worktree after use
 */
function removeWorktree(worktreePath: string): void {
  if (!worktreePath) return;

  try {
    // Safe: worktreePath comes from createWorktree which constructs it internally
    execSync(`git worktree remove "${worktreePath}" --force`, { stdio: 'pipe' });
  } catch {
    // Fallback to direct removal
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures
    }
  }
}

/**
 * Reset repository to clean state (fallback isolation method)
 */
function resetRepository(): void {
  try {
    execSync('git stash --include-untracked', { stdio: 'pipe' });
  } catch {
    // No changes to stash, continue
  }
}

/**
 * Parse command line arguments
 */
function parseArgs(): RunnerOptions {
  const args = process.argv.slice(2);
  const options: RunnerOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--task':
        options.taskId = next;
        i++;
        break;
      case '--resume':
        options.sessionId = next;
        i++;
        break;
      case '--report':
        options.sessionId = next;
        options.generateReportOnly = true;
        i++;
        break;
      case '--skip-vanilla':
        options.skipVanilla = true;
        break;
      case '--skip-orchestrator':
        options.skipOrchestrator = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--skip-scoring':
        options.skipScoring = true;
        break;
      case '--score-only':
        options.scoreOnly = true;
        options.sessionId = next;
        i++;
        break;
      case '--no-isolation':
        options.noIsolation = true;
        break;
      case '--quick':
        options.quick = true;
        break;
      case '--help':
        printHelp();
        process.exit(0);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
Orchestrator Benchmark Runner

Usage:
  npx ts-node runner.ts [options]

Options:
  --task <id>           Run only the specified task
  --resume <session>    Resume a previous benchmark session
  --report <session>    Generate report for a completed session
  --skip-vanilla        Skip vanilla Claude runs
  --skip-orchestrator   Skip orchestrator runs
  --dry-run             Show what would run without executing
  --skip-scoring        Skip scoring/judging after runs complete
  --score-only <session> Score an existing session without re-running
  --no-isolation        Disable git worktree isolation between runs
  --quick               Quick eval mode (6 tasks, 2 stages, 1 run = 24 runs)
  --help                Show this help message

Examples:
  npx ts-node runner.ts                    # Run full benchmark
  npx ts-node runner.ts --quick            # Quick eval (~30 min)
  npx ts-node runner.ts --task KA-1        # Run task KA-1 only
  npx ts-node runner.ts --resume benchmark-2026-02-03-12-00-00
  npx ts-node runner.ts --report benchmark-2026-02-03-12-00-00
  npx ts-node runner.ts --score-only benchmark-2026-02-03-12-00-00
`);
}

/**
 * Main benchmark runner
 */
async function main(): Promise<void> {
  const options = parseArgs();

  // Handle report-only mode
  if (options.generateReportOnly && options.sessionId) {
    console.log(`Generating report for session: ${options.sessionId}`);
    const report = generateReport(options.sessionId);
    if (!report) {
      console.error('Failed to generate report. Session may not exist or have no data.');
      process.exit(1);
    }
    saveReport(options.sessionId, report);
    printReportSummary(report);
    return;
  }

  // Handle score-only mode
  if (options.scoreOnly && options.sessionId) {
    console.log(`Scoring session: ${options.sessionId}`);
    const session = loadSession(options.sessionId);
    if (!session) {
      console.error(`Session not found: ${options.sessionId}`);
      process.exit(1);
    }
    await scoreSession(options.sessionId, session.tasks);
    const report = generateReport(options.sessionId);
    if (report) {
      saveReport(options.sessionId, report);
      printReportSummary(report);
    }
    return;
  }

  // Load tasks
  const suite = loadTaskSuite();
  let tasks = suite.tasks;

  // Apply quick eval filter
  const quickMode = options.quick && !options.taskId;
  const activeStages = quickMode ? QUICK_EVAL.stages : CONTEXT_STAGES;
  const activeRunsPerConfig = quickMode ? QUICK_EVAL.runsPerConfig : RUNS_PER_CONFIG;

  if (options.taskId) {
    const task = loadTask(options.taskId);
    if (!task) {
      console.error(`Task not found: ${options.taskId}`);
      process.exit(1);
    }
    tasks = [task];
  } else if (quickMode) {
    tasks = tasks.filter(t => QUICK_EVAL.taskIds.includes(t.id));
    if (tasks.length === 0) {
      console.error('No quick eval tasks found in task suite');
      process.exit(1);
    }
    console.log(`[QUICK EVAL] Running ${tasks.length} tasks with ${activeStages.join(', ')} stages, ${activeRunsPerConfig} run(s) each`);
  }

  // Initialize or resume session
  const sessionId = options.sessionId || generateSessionId();
  const isResume = !!options.sessionId;

  if (!isResume) {
    console.log(`Starting new benchmark session: ${sessionId}`);
    initSession(sessionId, tasks);
  } else {
    console.log(`Resuming benchmark session: ${sessionId}`);
    const session = loadSession(sessionId);
    if (!session) {
      console.error(`Session not found: ${sessionId}`);
      process.exit(1);
    }
  }

  // Calculate total runs
  const systemsToRun = SYSTEMS.filter(s => {
    if (s === 'vanilla' && options.skipVanilla) return false;
    if (s === 'orchestrator' && options.skipOrchestrator) return false;
    return true;
  });

  // Generate randomized run order
  const runConfigs = generateRunConfigs(tasks, systemsToRun, activeStages, activeRunsPerConfig);
  const totalRuns = runConfigs.length;

  console.log(`\nPlanned runs: ${totalRuns}`);
  console.log(`Tasks: ${tasks.length}`);
  console.log(`Systems: ${systemsToRun.join(', ')}`);
  console.log(`Context stages: ${activeStages.join(', ')}`);
  console.log(`Runs per config: ${activeRunsPerConfig}`);
  console.log(`Run order: RANDOMIZED (to reduce drift bias)`);
  console.log(`Isolation: ${options.noIsolation ? 'DISABLED' : 'git worktree per run'}\n`);

  if (options.dryRun) {
    console.log('Dry run mode - not executing tasks');
    printRunPlan(tasks, systemsToRun);
    console.log('\nRandomized execution order (first 10):');
    for (let i = 0; i < Math.min(10, runConfigs.length); i++) {
      const cfg = runConfigs[i];
      console.log(`  ${i + 1}. ${cfg.task.id}/${cfg.system}/${cfg.stage}/run${cfg.runNumber}`);
    }
    if (runConfigs.length > 10) {
      console.log(`  ... and ${runConfigs.length - 10} more`);
    }
    return;
  }

  // Execute benchmark runs in randomized order
  let completed = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < runConfigs.length; i++) {
    const { task, system, stage, runNumber } = runConfigs[i];

    console.log(`\n[${i + 1}/${totalRuns}] ${task.id}/${system}/${stage}/run${runNumber}`);

    // Check if already completed
    if (isRunComplete(sessionId, task.id, system, stage, runNumber)) {
      console.log(`  [SKIP] Already complete`);
      skipped++;
      continue;
    }

    // Create isolated worktree for this run (unless disabled)
    let worktreePath = '';
    let workingDir = resolve(task.workingDirectory);

    if (!options.noIsolation) {
      worktreePath = createWorktree(sessionId, i);
      if (worktreePath) {
        workingDir = worktreePath;
      } else {
        // Fallback: reset repository
        resetRepository();
      }
    }

    try {
      const run = await executeBenchmarkRun(task, system, stage, runNumber, workingDir);
      saveRun(sessionId, run);
      completed++;

      const status = run.error ? `ERROR: ${run.error}` : `OK (${run.durationMs}ms)`;
      console.log(`  ${status}`);

      if (run.error) {
        failed++;
      }
    } catch (err) {
      console.error(`  FAILED: ${err}`);
      failed++;
    } finally {
      // Clean up worktree
      if (worktreePath) {
        removeWorktree(worktreePath);
      }
    }
  }

  // Score/judge the runs
  if (!options.skipScoring) {
    console.log(`\n${'='.repeat(60)}`);
    console.log('Scoring Results');
    console.log(`${'='.repeat(60)}`);
    await scoreSession(sessionId, tasks);
  }

  // Complete session and generate report
  completeSession(sessionId);

  console.log(`\n${'='.repeat(60)}`);
  console.log('Benchmark Complete');
  console.log(`${'='.repeat(60)}`);
  console.log(`Session: ${sessionId}`);
  console.log(`Completed: ${completed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);

  // Generate and display report
  const report = generateReport(sessionId);
  if (report) {
    saveReport(sessionId, report);
    console.log('\n');
    printReportSummary(report);
  }
}

/**
 * Score all runs in a session
 */
async function scoreSession(sessionId: string, tasks: BenchmarkTask[]): Promise<void> {
  // Check ground truth for known-answer tasks
  if (!hasGroundTruth()) {
    console.warn('Ground truth not found. Run: npx ts-node tasks/setup/ground-truth.ts');
    console.warn('Skipping known-answer task scoring.\n');
  }

  for (const task of tasks) {
    console.log(`\nScoring ${task.id}: ${task.name}`);

    if (task.category === 'known-answer') {
      await scoreKnownAnswerTask(sessionId, task);
    } else if (task.category === 'niah') {
      await scoreNiahTask(sessionId, task);
    } else {
      await scoreRealCodebaseTask(sessionId, task);
    }
  }
}

/**
 * Score a known-answer task using ground truth comparison
 */
async function scoreKnownAnswerTask(sessionId: string, task: BenchmarkTask): Promise<void> {
  if (!hasGroundTruth()) {
    console.log('  [SKIP] No ground truth available');
    return;
  }

  for (const stage of CONTEXT_STAGES) {
    for (const system of SYSTEMS) {
      const runs = getRuns(sessionId, task.id, system, stage);

      for (const run of runs) {
        if (run.knownAnswerScore) {
          console.log(`  [SKIP] ${system}/${stage}/run${run.runNumber} - already scored`);
          continue;
        }

        if (!run.output || run.error) {
          console.log(`  [SKIP] ${system}/${stage}/run${run.runNumber} - no valid output`);
          continue;
        }

        try {
          const score = scoreKnownAnswer(task, run.output);
          run.knownAnswerScore = score;
          saveRun(sessionId, run);
          console.log(`  [SCORED] ${system}/${stage}/run${run.runNumber}: ${score.correctness}%`);
        } catch (e) {
          console.error(`  [ERROR] ${system}/${stage}/run${run.runNumber}: ${e}`);
        }
      }
    }
  }
}

/**
 * Score a NIAH task using deterministic needle retrieval checks
 */
async function scoreNiahTask(sessionId: string, task: BenchmarkTask): Promise<void> {
  for (const stage of CONTEXT_STAGES) {
    for (const system of SYSTEMS) {
      const runs = getRuns(sessionId, task.id, system, stage);

      for (const run of runs) {
        if (run.niahScore) {
          console.log(`  [SKIP] ${system}/${stage}/run${run.runNumber} - already scored`);
          continue;
        }

        if (!run.output || run.error) {
          console.log(`  [SKIP] ${system}/${stage}/run${run.runNumber} - no valid output`);
          continue;
        }

        try {
          const score = scoreNiah(task, run.output);
          run.niahScore = score;
          saveRun(sessionId, run);
          const correctness = niahScoreToCorrectness(score);
          const reasoning = score.reasoningCorrect !== undefined
            ? ` reasoning=${score.reasoningCorrect ? 'YES' : 'NO'}`
            : '';
          console.log(`  [SCORED] ${system}/${stage}/run${run.runNumber}: ${correctness}% retrieval${reasoning}`);
        } catch (e) {
          console.error(`  [ERROR] ${system}/${stage}/run${run.runNumber}: ${e}`);
        }
      }
    }
  }
}

/**
 * Score a real-codebase task using LLM judges
 */
async function scoreRealCodebaseTask(sessionId: string, task: BenchmarkTask): Promise<void> {
  // For each context stage, get vanilla and orchestrator outputs and compare
  for (const stage of CONTEXT_STAGES) {
    const vanillaRuns = getRuns(sessionId, task.id, 'vanilla', stage);
    const orchestratorRuns = getRuns(sessionId, task.id, 'orchestrator', stage);

    // Match runs by run number and judge pairs
    for (let runNum = 1; runNum <= RUNS_PER_CONFIG; runNum++) {
      const vanillaRun = vanillaRuns.find(r => r.runNumber === runNum);
      const orchRun = orchestratorRuns.find(r => r.runNumber === runNum);

      if (!vanillaRun || !orchRun) {
        console.log(`  [SKIP] ${stage}/run${runNum} - missing vanilla or orchestrator run`);
        continue;
      }

      if (orchRun.judgeScores) {
        console.log(`  [SKIP] ${stage}/run${runNum} - already judged`);
        continue;
      }

      if (!vanillaRun.output || !orchRun.output) {
        console.log(`  [SKIP] ${stage}/run${runNum} - missing output`);
        continue;
      }

      console.log(`  [JUDGING] ${stage}/run${runNum}...`);

      try {
        const scores = await evaluateWithJudges(task, vanillaRun.output, orchRun.output);

        if (scores) {
          // Store scores on orchestrator run (we compare against vanilla)
          orchRun.judgeScores = scores;
          saveRun(sessionId, orchRun);

          // Also create inverse scores for vanilla run
          const vanillaScores: JudgeScores = {
            claude: scores.claude, // Same judge, different perspective
            codex: scores.codex,
            needsHumanReview: scores.needsHumanReview,
          };
          vanillaRun.judgeScores = vanillaScores;
          saveRun(sessionId, vanillaRun);

          const avgScore = (scores.claude.completeness + scores.claude.accuracy + scores.claude.actionability) / 3;
          const reviewFlag = scores.needsHumanReview ? ' [NEEDS REVIEW]' : '';
          console.log(`            Orchestrator avg: ${avgScore.toFixed(1)}/10${reviewFlag}`);
        } else {
          console.log(`            Failed to get judge scores`);
        }
      } catch (e) {
        console.error(`  [ERROR] ${stage}/run${runNum}: ${e}`);
      }
    }
  }
}

/**
 * Execute a single benchmark run
 * @param workingDirectory - Optional isolated working directory (worktree path)
 */
async function executeBenchmarkRun(
  task: BenchmarkTask,
  system: SystemType,
  contextStage: ContextStage,
  runNumber: 1 | 2 | 3,
  workingDirectory?: string
): Promise<BenchmarkRun> {
  const startedAt = Date.now();
  const cwd = workingDirectory || resolve(task.workingDirectory);

  // Generate context for this stage (with needles for NIAH tasks)
  const contextResult = generateContext(contextStage, cwd, task.needles);
  const contextMessages = contextMessagesToStrings(contextResult.messages);

  // Create a modified task with the isolated working directory
  const isolatedTask = { ...task, workingDirectory: cwd };

  // Execute based on system type
  const executor = system === 'vanilla' ? executeVanilla : executeOrchestrator;
  const result = await executor(isolatedTask, { contextMessages });

  return {
    taskId: task.id,
    system,
    contextStage,
    runNumber,
    output: result.output,
    tokensUsed: result.tokensUsed,
    tokenBreakdown: result.tokenBreakdown,
    durationMs: result.durationMs,
    startedAt,
    completedAt: Date.now(),
    error: result.error,
  };
}

/**
 * Print planned runs without executing
 */
function printRunPlan(tasks: BenchmarkTask[], systems: SystemType[]): void {
  console.log('\nPlanned runs:');
  for (const task of tasks) {
    console.log(`\n  ${task.id}: ${task.name}`);
    for (const system of systems) {
      for (const stage of CONTEXT_STAGES) {
        console.log(`    - ${system}/${stage} x${RUNS_PER_CONFIG}`);
      }
    }
  }
}

/**
 * Print a summary of the benchmark report
 */
function printReportSummary(report: import('./types.js').BenchmarkReport): void {
  console.log('ORCHESTRATOR BENCHMARK RESULTS');
  console.log('==============================\n');

  const { summary, byComplexity } = report;

  console.log(
    `Overall: Orchestrator wins ${summary.orchestratorWins}/${report.tasks.length} tasks, ` +
      `ties ${summary.ties}, loses ${summary.vanillaWins}\n`
  );

  console.log('By Complexity:');
  console.log(
    `  Multi-file tasks:    Orchestrator ${byComplexity['multi-file'].orchestratorAvgScore.toFixed(1)} vs ` +
      `Vanilla ${byComplexity['multi-file'].vanillaAvgScore.toFixed(1)}`
  );
  console.log(
    `  Large-context tasks: Orchestrator ${byComplexity['large-context'].orchestratorAvgScore.toFixed(1)} vs ` +
      `Vanilla ${byComplexity['large-context'].vanillaAvgScore.toFixed(1)}`
  );
  console.log();

  console.log('Context Resilience (heavy/fresh score ratio):');
  console.log(`  Vanilla:      ${(summary.avgContextResilienceVanilla * 100).toFixed(1)}%`);
  console.log(`  Orchestrator: ${(summary.avgContextResilienceOrchestrator * 100).toFixed(1)}%`);
  console.log();

  console.log(`Cost Multiplier: ${summary.avgCostRatio.toFixed(2)}x`);
  console.log();

  console.log('Token Efficiency (tokens per correctness point):');
  console.log(`  Vanilla:      ${summary.avgTokensPerCorrectVanilla.toLocaleString()}`);
  console.log(`  Orchestrator: ${summary.avgTokensPerCorrectOrchestrator.toLocaleString()}`);
  console.log();

  // Show token breakdown if available
  if (summary.totalTokenBreakdown) {
    const vb = summary.totalTokenBreakdown.vanilla;
    const ob = summary.totalTokenBreakdown.orchestrator;
    console.log('Token Breakdown (totals across all runs):');
    console.log(`  Vanilla:      input=${vb.inputTokens.toLocaleString()} output=${vb.outputTokens.toLocaleString()} cache_read=${vb.cacheReadTokens.toLocaleString()} cache_write=${vb.cacheWriteTokens.toLocaleString()}`);
    console.log(`  Orchestrator: input=${ob.inputTokens.toLocaleString()} output=${ob.outputTokens.toLocaleString()} cache_read=${ob.cacheReadTokens.toLocaleString()} cache_write=${ob.cacheWriteTokens.toLocaleString()}`);
    console.log();
  }

  console.log('Per-Task Results:');
  console.log('-'.repeat(100));
  console.log(
    'Task'.padEnd(10) +
      'Winner'.padEnd(13) +
      'V Score'.padEnd(9) +
      'O Score'.padEnd(9) +
      'Cost'.padEnd(7) +
      'V tok/pt'.padEnd(10) +
      'O tok/pt'.padEnd(10) +
      'Resilience (V/O)'
  );
  console.log('-'.repeat(100));

  for (const result of report.tasks) {
    const stages = Object.values(result.medianScores.vanilla);
    const vanillaAvg = stages.reduce((a, b) => a + b, 0) / stages.length;
    const orchStages = Object.values(result.medianScores.orchestrator);
    const orchAvg = orchStages.reduce((a, b) => a + b, 0) / orchStages.length;

    const vTPC = result.tokenEfficiency?.vanilla.tokensPerCorrectPoint ?? 0;
    const oTPC = result.tokenEfficiency?.orchestrator.tokensPerCorrectPoint ?? 0;

    console.log(
      result.taskId.padEnd(10) +
        result.winner.padEnd(13) +
        vanillaAvg.toFixed(1).padEnd(9) +
        orchAvg.toFixed(1).padEnd(9) +
        `${result.costRatio.toFixed(1)}x`.padEnd(7) +
        `${vTPC.toLocaleString()}`.padEnd(10) +
        `${oTPC.toLocaleString()}`.padEnd(10) +
        `${(result.contextResilience.vanilla * 100).toFixed(0)}%/${(result.contextResilience.orchestrator * 100).toFixed(0)}%`
    );
  }
}

// Run main
main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
