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

import { resolve } from 'path';
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
} from './result-storage.js';
import type {
  BenchmarkTask,
  BenchmarkRun,
  ContextStage,
  SystemType,
} from './types.js';

// Configuration
const RUNS_PER_CONFIG = 3;
const CONTEXT_STAGES: ContextStage[] = ['fresh', 'moderate', 'heavy'];
const SYSTEMS: SystemType[] = ['vanilla', 'orchestrator'];

interface RunnerOptions {
  taskId?: string;
  sessionId?: string;
  generateReportOnly?: boolean;
  skipVanilla?: boolean;
  skipOrchestrator?: boolean;
  dryRun?: boolean;
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
  --help                Show this help message

Examples:
  npx ts-node runner.ts                    # Run full benchmark
  npx ts-node runner.ts --task KA-1        # Run task KA-1 only
  npx ts-node runner.ts --resume benchmark-2026-02-03-12-00-00
  npx ts-node runner.ts --report benchmark-2026-02-03-12-00-00
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

  // Load tasks
  const suite = loadTaskSuite();
  let tasks = suite.tasks;

  if (options.taskId) {
    const task = loadTask(options.taskId);
    if (!task) {
      console.error(`Task not found: ${options.taskId}`);
      process.exit(1);
    }
    tasks = [task];
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

  const totalRuns = tasks.length * systemsToRun.length * CONTEXT_STAGES.length * RUNS_PER_CONFIG;
  console.log(`\nPlanned runs: ${totalRuns}`);
  console.log(`Tasks: ${tasks.length}`);
  console.log(`Systems: ${systemsToRun.join(', ')}`);
  console.log(`Context stages: ${CONTEXT_STAGES.join(', ')}`);
  console.log(`Runs per config: ${RUNS_PER_CONFIG}\n`);

  if (options.dryRun) {
    console.log('Dry run mode - not executing tasks');
    printRunPlan(tasks, systemsToRun);
    return;
  }

  // Execute benchmark runs
  let completed = 0;
  let skipped = 0;
  let failed = 0;

  for (const task of tasks) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Task: ${task.id} - ${task.name}`);
    console.log(`${'='.repeat(60)}`);

    for (const system of systemsToRun) {
      for (const stage of CONTEXT_STAGES) {
        for (let runNum = 1; runNum <= RUNS_PER_CONFIG; runNum++) {
          const runNumber = runNum as 1 | 2 | 3;

          // Check if already completed
          if (isRunComplete(sessionId, task.id, system, stage, runNumber)) {
            console.log(`  [SKIP] ${system}/${stage}/run${runNumber} - already complete`);
            skipped++;
            continue;
          }

          console.log(`  [RUN] ${system}/${stage}/run${runNumber}...`);

          try {
            const run = await executeBenchmarkRun(task, system, stage, runNumber);
            saveRun(sessionId, run);
            completed++;

            const status = run.error ? `ERROR: ${run.error}` : `OK (${run.durationMs}ms)`;
            console.log(`        ${status}`);

            if (run.error) {
              failed++;
            }
          } catch (err) {
            console.error(`        FAILED: ${err}`);
            failed++;
          }
        }
      }
    }
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
 * Execute a single benchmark run
 */
async function executeBenchmarkRun(
  task: BenchmarkTask,
  system: SystemType,
  contextStage: ContextStage,
  runNumber: 1 | 2 | 3
): Promise<BenchmarkRun> {
  const startedAt = Date.now();
  const workingDirectory = resolve(task.workingDirectory);

  // Generate context for this stage
  const contextResult = generateContext(contextStage, workingDirectory);
  const contextMessages = contextMessagesToStrings(contextResult.messages);

  // Execute based on system type
  const executor = system === 'vanilla' ? executeVanilla : executeOrchestrator;
  const result = await executor(task, { contextMessages });

  return {
    taskId: task.id,
    system,
    contextStage,
    runNumber,
    output: result.output,
    filesExamined: result.filesExamined,
    tokensUsed: result.tokensUsed,
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

  console.log('Per-Task Results:');
  console.log('-'.repeat(80));
  console.log(
    'Task'.padEnd(10) +
      'Winner'.padEnd(15) +
      'Vanilla'.padEnd(10) +
      'Orch'.padEnd(10) +
      'Cost'.padEnd(8) +
      'Resilience (V/O)'
  );
  console.log('-'.repeat(80));

  for (const result of report.tasks) {
    const vanillaAvg =
      (result.medianScores.vanilla.fresh +
        result.medianScores.vanilla.moderate +
        result.medianScores.vanilla.heavy) /
      3;
    const orchAvg =
      (result.medianScores.orchestrator.fresh +
        result.medianScores.orchestrator.moderate +
        result.medianScores.orchestrator.heavy) /
      3;

    console.log(
      result.taskId.padEnd(10) +
        result.winner.padEnd(15) +
        vanillaAvg.toFixed(1).padEnd(10) +
        orchAvg.toFixed(1).padEnd(10) +
        `${result.costRatio.toFixed(1)}x`.padEnd(8) +
        `${(result.contextResilience.vanilla * 100).toFixed(0)}%/${(result.contextResilience.orchestrator * 100).toFixed(0)}%`
    );
  }
}

// Run main
main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
