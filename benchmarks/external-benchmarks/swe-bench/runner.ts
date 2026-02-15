/**
 * SWE-bench Runner - Runs SWE-bench Lite against vanilla Claude and orchestrator
 *
 * Usage:
 *   npx ts-node runner.ts                        # Run full SWE-bench Lite (300 tasks)
 *   npx ts-node runner.ts --limit 10             # Run first 10 tasks
 *   npx ts-node runner.ts --system vanilla       # Run only vanilla
 *   npx ts-node runner.ts --eval-only <session>  # Re-evaluate existing patches
 *   npx ts-node runner.ts --report <session>     # Generate report from results
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { spawn } from 'child_process';
import type {
  SWEBenchTask,
  SWEBenchResult,
  SWEBenchReport,
  SWEBenchSystemResult,
  BreakEvenAnalysis,
  RunnerOptions,
  SessionResults,
} from './types.js';
import { generatePatchVanilla, generatePatchOrchestrator, writePatch } from './adapter.js';

const SCRIPT_DIR = resolve(import.meta.dirname);
const DATA_DIR = join(SCRIPT_DIR, 'data');
const RESULTS_DIR = join(SCRIPT_DIR, 'results');
const WORK_DIR = join(SCRIPT_DIR, 'workdir');

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const options = parseArgs();

  // Ensure directories exist
  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(WORK_DIR, { recursive: true });

  // Handle report-only mode
  if (options.reportOnly) {
    await generateReportOnly(options.reportOnly);
    return;
  }

  // Handle eval-only mode
  if (options.evalOnly) {
    await evaluateOnly(options.evalOnly);
    return;
  }

  // Run full benchmark
  await runBenchmark(options);
}

/**
 * Run the full benchmark
 */
async function runBenchmark(options: RunnerOptions): Promise<void> {
  const sessionId = options.sessionId || generateSessionId();
  const sessionDir = join(RESULTS_DIR, sessionId);
  mkdirSync(sessionDir, { recursive: true });

  console.log('🚀 SWE-bench Lite Benchmark');
  console.log('==========================');
  console.log(`Session ID: ${sessionId}`);
  console.log(`Results dir: ${sessionDir}`);
  console.log('');

  // Load tasks
  const allTasks = loadTasks();
  const tasks = options.limit ? allTasks.slice(0, options.limit) : allTasks;

  console.log(`📋 Loaded ${tasks.length} tasks (${allTasks.length} total available)`);
  console.log('');

  // Load existing results if resuming
  const sessionResults: SessionResults = options.resume
    ? loadSessionResults(sessionDir)
    : {
        sessionId,
        startedAt: Date.now(),
        tasks: new Map(),
        metadata: {
          totalTasks: tasks.length,
          tasksCompleted: 0,
          lastUpdated: Date.now(),
        },
      };

  // Run tasks
  const runVanilla = options.system !== 'orchestrator';
  const runOrchestrator = options.system !== 'vanilla';

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const progress = `[${i + 1}/${tasks.length}]`;

    console.log(`\n${progress} Task: ${task.instanceId}`);
    console.log(`Repository: ${task.repo}`);
    console.log('─'.repeat(60));

    // Check if already completed
    const existing = sessionResults.tasks.get(task.instanceId);
    const needVanilla = runVanilla && !existing?.vanilla;
    const needOrchestrator = runOrchestrator && !existing?.orchestrator;

    if (!needVanilla && !needOrchestrator) {
      console.log('✓ Already completed (skipping)');
      continue;
    }

    // Setup task workspace
    const taskWorkDir = await setupTaskWorkspace(task);

    // Run vanilla
    if (needVanilla) {
      console.log('\n🔵 Running vanilla Claude...');
      const vanillaResult = await generatePatchVanilla(task, taskWorkDir);

      console.log(`   Tokens: ${vanillaResult.tokensUsed.toLocaleString()}`);
      console.log(`   Duration: ${(vanillaResult.durationMs / 1000).toFixed(1)}s`);

      if (vanillaResult.error) {
        console.log(`   ❌ Error: ${vanillaResult.error}`);
      } else {
        console.log(`   ✓ Patch generated (${vanillaResult.patch.length} chars)`);
      }

      // Save patch
      const vanillaPatchPath = join(sessionDir, `${task.instanceId}_vanilla.patch`);
      writePatch(vanillaResult.patch, vanillaPatchPath);

      // Update results
      if (!sessionResults.tasks.has(task.instanceId)) {
        sessionResults.tasks.set(task.instanceId, {});
      }
      sessionResults.tasks.get(task.instanceId)!.vanilla = vanillaResult;
    }

    // Run orchestrator
    if (needOrchestrator) {
      console.log('\n🟣 Running orchestrator...');
      const orchestratorResult = await generatePatchOrchestrator(task, taskWorkDir);

      console.log(`   Tokens: ${orchestratorResult.tokensUsed.toLocaleString()}`);
      console.log(`   Duration: ${(orchestratorResult.durationMs / 1000).toFixed(1)}s`);
      console.log(`   Agent turns: ${orchestratorResult.agentTurns}`);

      if (orchestratorResult.error) {
        console.log(`   ❌ Error: ${orchestratorResult.error}`);
      } else {
        console.log(`   ✓ Patch generated (${orchestratorResult.patch.length} chars)`);
      }

      // Save patch
      const orchestratorPatchPath = join(sessionDir, `${task.instanceId}_orchestrator.patch`);
      writePatch(orchestratorResult.patch, orchestratorPatchPath);

      // Update results
      if (!sessionResults.tasks.has(task.instanceId)) {
        sessionResults.tasks.set(task.instanceId, {});
      }
      sessionResults.tasks.get(task.instanceId)!.orchestrator = orchestratorResult;
    }

    // Save progress
    sessionResults.metadata.tasksCompleted++;
    sessionResults.metadata.lastUpdated = Date.now();
    saveSessionResults(sessionDir, sessionResults);

    console.log(`\n✓ Progress saved (${sessionResults.metadata.tasksCompleted}/${tasks.length})`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ Benchmark generation complete!');
  console.log('');
  console.log('Next steps:');
  console.log(`  1. Evaluate patches: npx ts-node runner.ts --eval-only ${sessionId}`);
  console.log(`  2. View report: npx ts-node runner.ts --report ${sessionId}`);
  console.log('');
}

/**
 * Evaluate existing patches
 */
async function evaluateOnly(sessionId: string): Promise<void> {
  const sessionDir = join(RESULTS_DIR, sessionId);

  if (!existsSync(sessionDir)) {
    console.error(`❌ Session not found: ${sessionId}`);
    process.exit(1);
  }

  console.log('🧪 Evaluating patches...');
  console.log(`Session: ${sessionId}`);
  console.log('');

  // Load session results
  const sessionResults = loadSessionResults(sessionDir);

  // Create predictions file for SWE-bench evaluator
  const predictions = [];
  const allResults: SWEBenchResult[] = [];

  for (const [instanceId, results] of sessionResults.tasks.entries()) {
    if (results.vanilla?.patch) {
      predictions.push({
        instance_id: instanceId,
        model_patch: results.vanilla.patch,
        model_name_or_path: 'vanilla-claude',
      });
      allResults.push(results.vanilla);
    }

    if (results.orchestrator?.patch) {
      predictions.push({
        instance_id: instanceId,
        model_patch: results.orchestrator.patch,
        model_name_or_path: 'orchestrator-claude',
      });
      allResults.push(results.orchestrator);
    }
  }

  const predictionsPath = join(sessionDir, 'predictions.json');
  writeFileSync(predictionsPath, JSON.stringify(predictions, null, 2));

  console.log(`📝 Created predictions file: ${predictions.length} patches`);
  console.log('');

  // Run Python evaluation bridge
  console.log('🐍 Running SWE-bench evaluation (this may take a while)...');
  console.log('');

  const evalResultsPath = join(sessionDir, 'evaluation.json');
  const evalResult = await runPythonEvaluation(predictionsPath, evalResultsPath);

  if (!evalResult.success) {
    console.error(`❌ Evaluation failed: ${evalResult.error}`);
    process.exit(1);
  }

  console.log('✅ Evaluation complete!');
  console.log('');

  // Parse evaluation results and update session
  const evalData = JSON.parse(readFileSync(evalResultsPath, 'utf-8'));
  updateResultsWithEvaluation(sessionResults, evalData);

  // Save updated results
  saveSessionResults(sessionDir, sessionResults);

  // Generate and display report
  const report = generateReport(sessionResults);
  saveReport(sessionDir, report);
  printReport(report);
}

/**
 * Generate report from existing session
 */
async function generateReportOnly(sessionId: string): Promise<void> {
  const sessionDir = join(RESULTS_DIR, sessionId);

  if (!existsSync(sessionDir)) {
    console.error(`❌ Session not found: ${sessionId}`);
    process.exit(1);
  }

  const sessionResults = loadSessionResults(sessionDir);
  const report = generateReport(sessionResults);

  saveReport(sessionDir, report);
  printReport(report);
}

/**
 * Load SWE-bench tasks from dataset
 */
function loadTasks(limit?: number): SWEBenchTask[] {
  const dataFile = join(DATA_DIR, 'swe-bench-lite.json');

  if (!existsSync(dataFile)) {
    console.error('❌ Dataset not found. Run setup.sh first:');
    console.error('   ./setup.sh');
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(dataFile, 'utf-8'));
  const tasks: SWEBenchTask[] = data.map((item: any) => ({
    instanceId: item.instance_id,
    repo: item.repo,
    baseCommit: item.base_commit,
    problem_statement: item.problem_statement,
    hints_text: item.hints_text || '',
    test_patch: item.test_patch,
    environment_setup_commit: item.environment_setup_commit,
    version: item.version,
    created_at: item.created_at,
    patch: item.patch,
    FAIL_TO_PASS: item.FAIL_TO_PASS,
    PASS_TO_PASS: item.PASS_TO_PASS,
  }));

  return limit ? tasks.slice(0, limit) : tasks;
}

/**
 * Setup workspace for a task (clone repo, checkout commit)
 */
async function setupTaskWorkspace(task: SWEBenchTask): Promise<string> {
  // Create task-specific directory
  const taskDir = join(WORK_DIR, task.instanceId.replace(/[^a-zA-Z0-9-_]/g, '_'));

  // For now, just return the work directory
  // In a full implementation, we would:
  // 1. Clone the repository
  // 2. Checkout the base commit
  // 3. Apply environment setup

  mkdirSync(taskDir, { recursive: true });
  return taskDir;
}

/**
 * Run Python evaluation script
 */
function runPythonEvaluation(
  predictionsPath: string,
  outputPath: string
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const pythonScript = join(SCRIPT_DIR, 'evaluate.py');
    const child = spawn('python3', [pythonScript, predictionsPath, outputPath]);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      process.stdout.write(data);
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ success: false, error: stderr || 'Evaluation failed' });
      } else {
        try {
          const result = JSON.parse(stdout);
          resolve(result);
        } catch {
          resolve({ success: true });
        }
      }
    });
  });
}

/**
 * Update results with evaluation data
 */
function updateResultsWithEvaluation(sessionResults: SessionResults, evalData: any): void {
  if (!evalData.results) return;

  for (const [instanceId, taskResults] of sessionResults.tasks.entries()) {
    // Find evaluation results for this instance
    const vanillaEval = evalData.results.find(
      (r: any) => r.instance_id === instanceId && r.model_name_or_path === 'vanilla-claude'
    );
    const orchestratorEval = evalData.results.find(
      (r: any) => r.instance_id === instanceId && r.model_name_or_path === 'orchestrator-claude'
    );

    if (taskResults.vanilla && vanillaEval) {
      taskResults.vanilla.resolved = vanillaEval.resolved || false;
      taskResults.vanilla.testResults = vanillaEval.test_results;
    }

    if (taskResults.orchestrator && orchestratorEval) {
      taskResults.orchestrator.resolved = orchestratorEval.resolved || false;
      taskResults.orchestrator.testResults = orchestratorEval.test_results;
    }
  }
}

/**
 * Generate comprehensive report
 */
function generateReport(sessionResults: SessionResults): SWEBenchReport {
  const allResults: SWEBenchResult[] = [];
  const vanillaResults: SWEBenchResult[] = [];
  const orchestratorResults: SWEBenchResult[] = [];

  for (const taskResults of sessionResults.tasks.values()) {
    if (taskResults.vanilla) {
      vanillaResults.push(taskResults.vanilla);
      allResults.push(taskResults.vanilla);
    }
    if (taskResults.orchestrator) {
      orchestratorResults.push(taskResults.orchestrator);
      allResults.push(taskResults.orchestrator);
    }
  }

  const vanillaStats = calculateSystemStats(vanillaResults);
  const orchestratorStats = calculateSystemStats(orchestratorResults);
  const breakEven = generateBreakEvenAnalysis(vanillaResults, orchestratorResults, sessionResults);

  return {
    totalTasks: 300, // SWE-bench Lite total
    tasksRun: sessionResults.tasks.size,
    results: {
      vanilla: vanillaStats,
      orchestrator: orchestratorStats,
    },
    tasks: allResults,
    breakEven,
    sessionId: sessionResults.sessionId,
    startedAt: sessionResults.startedAt,
    completedAt: sessionResults.metadata.lastUpdated,
  };
}

/**
 * Calculate statistics for a system
 */
function calculateSystemStats(results: SWEBenchResult[]): SWEBenchSystemResult {
  if (results.length === 0) {
    return {
      resolved: 0,
      resolutionRate: 0,
      avgTokensPerTask: 0,
      avgTokensPerResolvedTask: 0,
      avgInputTokens: 0,
      avgOutputTokens: 0,
      avgDurationMs: 0,
      avgAgentTurns: 0,
      costPerResolution: 0,
      medianTokensPerTask: 0,
      medianDurationMs: 0,
    };
  }

  const resolved = results.filter((r) => r.resolved).length;
  const resolvedResults = results.filter((r) => r.resolved);

  const totalTokens = results.reduce((sum, r) => sum + r.tokensUsed, 0);
  const totalInputTokens = results.reduce((sum, r) => sum + r.inputTokens, 0);
  const totalOutputTokens = results.reduce((sum, r) => sum + r.outputTokens, 0);
  const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);
  const totalTurns = results.reduce((sum, r) => sum + r.agentTurns, 0);

  const resolvedTokens = resolvedResults.reduce((sum, r) => sum + r.tokensUsed, 0);

  const sortedTokens = [...results].map((r) => r.tokensUsed).sort((a, b) => a - b);
  const sortedDurations = [...results].map((r) => r.durationMs).sort((a, b) => a - b);

  return {
    resolved,
    resolutionRate: (resolved / results.length) * 100,
    avgTokensPerTask: totalTokens / results.length,
    avgTokensPerResolvedTask: resolvedResults.length > 0 ? resolvedTokens / resolvedResults.length : 0,
    avgInputTokens: totalInputTokens / results.length,
    avgOutputTokens: totalOutputTokens / results.length,
    avgDurationMs: totalDuration / results.length,
    avgAgentTurns: totalTurns / results.length,
    costPerResolution: resolvedResults.length > 0 ? totalTokens / resolved : 0,
    medianTokensPerTask: sortedTokens[Math.floor(sortedTokens.length / 2)],
    medianDurationMs: sortedDurations[Math.floor(sortedDurations.length / 2)],
  };
}

/**
 * Generate break-even analysis
 */
function generateBreakEvenAnalysis(
  vanillaResults: SWEBenchResult[],
  orchestratorResults: SWEBenchResult[],
  sessionResults: SessionResults
): BreakEvenAnalysis {
  const orchestratorOnlyResolutions: string[] = [];
  const vanillaOnlyResolutions: string[] = [];
  const bothResolved: string[] = [];

  // Compare results for each task
  for (const [instanceId, taskResults] of sessionResults.tasks.entries()) {
    const vanillaResolved = taskResults.vanilla?.resolved || false;
    const orchestratorResolved = taskResults.orchestrator?.resolved || false;

    if (orchestratorResolved && vanillaResolved) {
      bothResolved.push(instanceId);
    } else if (orchestratorResolved && !vanillaResolved) {
      orchestratorOnlyResolutions.push(instanceId);
    } else if (vanillaResolved && !orchestratorResolved) {
      vanillaOnlyResolutions.push(instanceId);
    }
  }

  // Calculate efficiency metrics
  const vanillaStats = calculateSystemStats(vanillaResults);
  const orchestratorStats = calculateSystemStats(orchestratorResults);

  const vanillaTokensPerResolution =
    vanillaStats.resolved > 0 ? vanillaStats.avgTokensPerResolvedTask : 0;
  const orchestratorTokensPerResolution =
    orchestratorStats.resolved > 0 ? orchestratorStats.avgTokensPerResolvedTask : 0;

  const efficiencyRatio =
    vanillaTokensPerResolution > 0 ? orchestratorTokensPerResolution / vanillaTokensPerResolution : 0;

  // Calculate token cost per additional resolution
  const netGain = orchestratorOnlyResolutions.length - vanillaOnlyResolutions.length;
  const totalOrchestratorTokens = orchestratorResults.reduce((sum, r) => sum + r.tokensUsed, 0);
  const totalVanillaTokens = vanillaResults.reduce((sum, r) => sum + r.tokensUsed, 0);
  const additionalTokens = totalOrchestratorTokens - totalVanillaTokens;
  const tokenCostPerAdditionalResolution =
    netGain > 0 ? additionalTokens / netGain : additionalTokens;

  // Determine if cost justified
  const improvementPercent =
    vanillaStats.resolutionRate > 0
      ? ((orchestratorStats.resolutionRate - vanillaStats.resolutionRate) / vanillaStats.resolutionRate) *
        100
      : 0;

  const costJustified =
    netGain > 0 && (efficiencyRatio < 2.0 || improvementPercent > 10);

  // Generate summary
  let summary = `Orchestrator achieved ${orchestratorStats.resolved} resolutions vs ${vanillaStats.resolved} for vanilla (${improvementPercent.toFixed(1)}% improvement). `;

  if (netGain > 0) {
    summary += `Net gain of ${netGain} additional resolutions at a cost of ${tokenCostPerAdditionalResolution.toLocaleString()} tokens per resolution. `;
  } else if (netGain < 0) {
    summary += `Net loss of ${Math.abs(netGain)} resolutions despite higher token usage. `;
  } else {
    summary += `Equal resolutions but orchestrator used ${efficiencyRatio.toFixed(2)}x more tokens. `;
  }

  if (costJustified) {
    summary += 'The orchestrator is cost-justified for these tasks.';
  } else {
    summary += 'The orchestrator is NOT cost-justified for these tasks.';
  }

  return {
    orchestratorOnlyResolutions,
    vanillaOnlyResolutions,
    bothResolved,
    tokenCostPerAdditionalResolution,
    difficultyBreakpoint:
      netGain > 0 ? 'Medium to hard tasks (requires multi-step reasoning)' : 'Not determined',
    costJustified,
    summary,
    efficiency: {
      vanillaTokensPerResolution,
      orchestratorTokensPerResolution,
      efficiencyRatio,
    },
    winLoss: {
      orchestratorWins: orchestratorOnlyResolutions.length,
      vanillaWins: vanillaOnlyResolutions.length,
      netGain,
      improvementPercent,
    },
  };
}

/**
 * Print comprehensive report
 */
function printReport(report: SWEBenchReport): void {
  console.log('');
  console.log('='.repeat(80));
  console.log('📊 SWE-bench Lite Benchmark Report');
  console.log('='.repeat(80));
  console.log('');

  console.log(`Session ID: ${report.sessionId}`);
  console.log(`Tasks Run: ${report.tasksRun} / ${report.totalTasks}`);
  console.log(`Duration: ${((report.completedAt - report.startedAt) / 1000 / 60).toFixed(1)} minutes`);
  console.log('');

  console.log('─'.repeat(80));
  console.log('🔵 Vanilla Claude Results');
  console.log('─'.repeat(80));
  printSystemStats(report.results.vanilla);
  console.log('');

  console.log('─'.repeat(80));
  console.log('🟣 Orchestrator Results');
  console.log('─'.repeat(80));
  printSystemStats(report.results.orchestrator);
  console.log('');

  console.log('─'.repeat(80));
  console.log('⚖️  Break-Even Analysis');
  console.log('─'.repeat(80));
  printBreakEvenAnalysis(report.breakEven);
  console.log('');

  console.log('='.repeat(80));
  console.log('');
}

/**
 * Print system statistics
 */
function printSystemStats(stats: SWEBenchSystemResult): void {
  console.log(`  Resolutions:           ${stats.resolved} (${stats.resolutionRate.toFixed(1)}%)`);
  console.log(
    `  Avg Tokens/Task:       ${stats.avgTokensPerTask.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  );
  console.log(
    `  Avg Tokens/Resolution: ${stats.avgTokensPerResolvedTask.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  );
  console.log(
    `  Median Tokens/Task:    ${stats.medianTokensPerTask.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  );
  console.log(
    `  Avg Input Tokens:      ${stats.avgInputTokens.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  );
  console.log(
    `  Avg Output Tokens:     ${stats.avgOutputTokens.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  );
  console.log(`  Avg Duration:          ${(stats.avgDurationMs / 1000).toFixed(1)}s`);
  console.log(`  Avg Agent Turns:       ${stats.avgAgentTurns.toFixed(1)}`);
  console.log(
    `  Cost/Resolution:       ${stats.costPerResolution.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens`
  );
}

/**
 * Print break-even analysis
 */
function printBreakEvenAnalysis(analysis: BreakEvenAnalysis): void {
  console.log(`  Orchestrator-Only Wins: ${analysis.winLoss.orchestratorWins}`);
  console.log(`  Vanilla-Only Wins:      ${analysis.winLoss.vanillaWins}`);
  console.log(`  Both Resolved:          ${analysis.bothResolved.length}`);
  console.log(`  Net Gain:               ${analysis.winLoss.netGain > 0 ? '+' : ''}${analysis.winLoss.netGain}`);
  console.log(`  Improvement:            ${analysis.winLoss.improvementPercent > 0 ? '+' : ''}${analysis.winLoss.improvementPercent.toFixed(1)}%`);
  console.log('');
  console.log(`  Token Efficiency:`);
  console.log(
    `    Vanilla:       ${analysis.efficiency.vanillaTokensPerResolution.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens/resolution`
  );
  console.log(
    `    Orchestrator:  ${analysis.efficiency.orchestratorTokensPerResolution.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens/resolution`
  );
  console.log(`    Ratio:         ${analysis.efficiency.efficiencyRatio.toFixed(2)}x`);
  console.log('');
  console.log(
    `  Cost/Additional Resolution: ${analysis.tokenCostPerAdditionalResolution.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens`
  );
  console.log(`  Difficulty Breakpoint:      ${analysis.difficultyBreakpoint}`);
  console.log('');
  console.log(`  ${analysis.costJustified ? '✅' : '❌'} ${analysis.summary}`);
}

/**
 * Save session results
 */
function saveSessionResults(sessionDir: string, results: SessionResults): void {
  const resultsPath = join(sessionDir, 'session.json');

  // Convert Map to object for JSON serialization
  const tasksObject: Record<string, any> = {};
  for (const [key, value] of results.tasks.entries()) {
    tasksObject[key] = value;
  }

  const serializable = {
    ...results,
    tasks: tasksObject,
  };

  writeFileSync(resultsPath, JSON.stringify(serializable, null, 2));
}

/**
 * Load session results
 */
function loadSessionResults(sessionDir: string): SessionResults {
  const resultsPath = join(sessionDir, 'session.json');

  if (!existsSync(resultsPath)) {
    throw new Error(`Session results not found: ${resultsPath}`);
  }

  const data = JSON.parse(readFileSync(resultsPath, 'utf-8'));

  // Convert object back to Map
  const tasksMap = new Map<string, any>();
  for (const [key, value] of Object.entries(data.tasks)) {
    tasksMap.set(key, value);
  }

  return {
    ...data,
    tasks: tasksMap,
  };
}

/**
 * Save report
 */
function saveReport(sessionDir: string, report: SWEBenchReport): void {
  const reportPath = join(sessionDir, 'report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n📄 Report saved: ${reportPath}`);
}

/**
 * Parse command-line arguments
 */
function parseArgs(): RunnerOptions {
  const args = process.argv.slice(2);
  const options: RunnerOptions = {
    system: 'both',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--limit':
        options.limit = parseInt(args[++i], 10);
        break;
      case '--system':
        const system = args[++i];
        if (system !== 'vanilla' && system !== 'orchestrator' && system !== 'both') {
          console.error('Invalid --system value. Must be: vanilla, orchestrator, or both');
          process.exit(1);
        }
        options.system = system === 'both' ? undefined : system;
        break;
      case '--eval-only':
        options.evalOnly = args[++i];
        break;
      case '--report':
        options.reportOnly = args[++i];
        break;
      case '--session':
        options.sessionId = args[++i];
        break;
      case '--resume':
        options.resume = true;
        break;
      case '--work-dir':
        options.workDir = args[++i];
        break;
      case '--timeout':
        options.timeoutMinutes = parseInt(args[++i], 10);
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        printHelp();
        process.exit(1);
    }
  }

  return options;
}

/**
 * Generate session ID
 */
function generateSessionId(): string {
  const date = new Date();
  const timestamp = date.toISOString().replace(/[:.]/g, '-').substring(0, 19);
  return `swebench_${timestamp}`;
}

/**
 * Print help message
 */
function printHelp(): void {
  console.log(`
SWE-bench Lite Runner

Usage:
  npx ts-node runner.ts [options]

Options:
  --limit <n>           Run only first N tasks
  --system <type>       Run only 'vanilla', 'orchestrator', or 'both' (default: both)
  --eval-only <session> Re-evaluate existing patches without regenerating
  --report <session>    Generate report from existing results
  --session <id>        Use specific session ID
  --resume              Resume incomplete session (skip completed tasks)
  --work-dir <path>     Custom working directory for task execution
  --timeout <minutes>   Timeout per task in minutes (default: 30)
  --help                Show this help message

Examples:
  # Run first 10 tasks with both systems
  npx ts-node runner.ts --limit 10

  # Run only vanilla on all tasks
  npx ts-node runner.ts --system vanilla

  # Evaluate existing patches
  npx ts-node runner.ts --eval-only swebench_2024-01-15T10-30-00

  # Generate report only
  npx ts-node runner.ts --report swebench_2024-01-15T10-30-00

  # Resume interrupted benchmark
  npx ts-node runner.ts --resume --session swebench_2024-01-15T10-30-00
  `);
}

// Run main
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
