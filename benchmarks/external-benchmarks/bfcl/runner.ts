#!/usr/bin/env node
/**
 * BFCL Runner - Runs Berkeley Function Calling benchmark against
 * vanilla Claude and orchestrator
 *
 * Usage:
 *   npx ts-node runner.ts                    # Run full BFCL suite
 *   npx ts-node runner.ts --limit 20         # Run first 20 cases
 *   npx ts-node runner.ts --system vanilla   # Run only vanilla
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { parseModelOutput, scoreFunctionCall } from './scorer.js';
import { SAMPLE_TEST_CASES } from './sample-data.js';
import type { BFCLTestCase, BFCLResult, BFCLReport, BFCLFunctionCall } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface RunOptions {
  limit?: number;
  system?: 'vanilla' | 'orchestrator' | 'both';
  output?: string;
}

interface ExecutionResult {
  output: string;
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error?: string;
}

/**
 * Load test cases from data directory or use built-in samples
 */
function loadTestCases(limit?: number): BFCLTestCase[] {
  const dataDir = join(__dirname, 'data');
  const dataFile = join(dataDir, 'gorilla_openfunctions_v1_test_executable_simple.json');

  let cases: BFCLTestCase[] = [];

  // Try to load from downloaded data
  if (existsSync(dataFile)) {
    try {
      const content = readFileSync(dataFile, 'utf-8');
      const rawData = JSON.parse(content);

      // Convert BFCL format to our format
      cases = rawData.map((item: any, idx: number) => ({
        id: item.id || `bfcl-${idx}`,
        question: item.question || item.prompt,
        functions: item.functions || [],
        groundTruth: item.ground_truth || item.expected_output
      }));

      console.log(`Loaded ${cases.length} test cases from ${dataFile}`);
    } catch (err) {
      console.warn(`Failed to load data file: ${err}`);
      console.log('Using built-in sample data instead');
      cases = SAMPLE_TEST_CASES;
    }
  } else {
    console.log('No downloaded data found, using built-in sample data');
    cases = SAMPLE_TEST_CASES;
  }

  // Apply limit if specified
  if (limit && limit > 0) {
    cases = cases.slice(0, limit);
  }

  return cases;
}

/**
 * Build a function calling prompt from a test case
 */
function buildFunctionCallingPrompt(testCase: BFCLTestCase): string {
  const functionsJson = JSON.stringify(testCase.functions, null, 2);

  return `You are a function calling assistant. Given a user question and a list of available functions, you must determine which function to call and with what arguments.

Available functions:
${functionsJson}

User question: ${testCase.question}

Please respond with a function call in the following JSON format:
{
  "name": "function_name",
  "arguments": {
    "param1": "value1",
    "param2": "value2"
  }
}

Only respond with the JSON function call, nothing else.`;
}

/**
 * Execute vanilla Claude CLI
 */
async function executeVanilla(prompt: string): Promise<ExecutionResult> {
  const startTime = Date.now();

  return new Promise((resolve) => {
    const args = [
      '--print',
      '--output-format', 'json'
    ];

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    // Send prompt
    proc.stdin?.write(prompt);
    proc.stdin?.end();

    // Timeout after 2 minutes
    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({
        output: stdout || 'Timeout',
        tokensUsed: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - startTime,
        error: 'Timeout after 120s'
      });
    }, 120000);

    proc.on('close', (code) => {
      clearTimeout(timeout);

      let output = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let tokensUsed = 0;

      // Parse JSON output
      try {
        const lines = stdout.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);

            // Extract text from assistant messages
            if (parsed.type === 'assistant' && parsed.message?.content) {
              for (const block of parsed.message.content) {
                if (block.type === 'text') {
                  output += block.text + '\n';
                }
              }
            }

            // Extract from result messages
            if (parsed.type === 'result') {
              if (parsed.result && typeof parsed.result === 'string') {
                output += parsed.result + '\n';
              }
              if (parsed.usage) {
                inputTokens = parsed.usage.input_tokens || 0;
                outputTokens = parsed.usage.output_tokens || 0;
                tokensUsed = inputTokens + outputTokens;
              }
            }
          } catch {
            // Not JSON, append as raw
            output += line + '\n';
          }
        }
      } catch {
        output = stdout;
      }

      const durationMs = Date.now() - startTime;

      resolve({
        output: output.trim() || stdout.trim(),
        tokensUsed,
        inputTokens,
        outputTokens,
        durationMs,
        error: code !== 0 ? `Exit code: ${code}. Stderr: ${stderr}` : undefined
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        output: '',
        tokensUsed: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - startTime,
        error: `Process error: ${err.message}`
      });
    });
  });
}

/**
 * Execute orchestrator (placeholder for future implementation)
 */
async function executeOrchestrator(_prompt: string): Promise<ExecutionResult> {
  // TODO: Implement orchestrator execution
  // For now, return a placeholder
  return {
    output: '{"name": "placeholder", "arguments": {}}',
    tokensUsed: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    error: 'Orchestrator execution not yet implemented'
  };
}

/**
 * Evaluate a single test case
 */
async function evaluateTestCase(
  testCase: BFCLTestCase,
  system: 'vanilla' | 'orchestrator'
): Promise<BFCLResult> {
  const prompt = buildFunctionCallingPrompt(testCase);

  // Execute
  const result = system === 'vanilla'
    ? await executeVanilla(prompt)
    : await executeOrchestrator(prompt);

  // Parse model output
  const parsedCall = parseModelOutput(result.output);

  // Score
  let functionNameCorrect = false;
  let parametersCorrect = false;

  if (parsedCall) {
    const score = scoreFunctionCall(parsedCall, testCase.groundTruth);
    functionNameCorrect = score.nameCorrect;
    parametersCorrect = score.paramsCorrect;
  }

  const pass = functionNameCorrect && parametersCorrect;

  return {
    testCaseId: testCase.id,
    system,
    functionNameCorrect,
    parametersCorrect,
    pass,
    rawOutput: result.output,
    parsedCall: parsedCall ?? undefined,
    tokensUsed: result.tokensUsed,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: result.durationMs,
    error: result.error
  };
}

/**
 * Calculate aggregate statistics
 */
function calculateStats(results: BFCLResult[]) {
  if (results.length === 0) {
    return {
      passRate: 0,
      functionNameAccuracy: 0,
      parameterAccuracy: 0,
      avgTokensUsed: 0,
      avgInputTokens: 0,
      avgOutputTokens: 0,
      avgDurationMs: 0
    };
  }

  const passes = results.filter(r => r.pass).length;
  const nameCorrect = results.filter(r => r.functionNameCorrect).length;
  const paramsCorrect = results.filter(r => r.parametersCorrect).length;

  const totalTokens = results.reduce((sum, r) => sum + r.tokensUsed, 0);
  const totalInput = results.reduce((sum, r) => sum + r.inputTokens, 0);
  const totalOutput = results.reduce((sum, r) => sum + r.outputTokens, 0);
  const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);

  return {
    passRate: passes / results.length,
    functionNameAccuracy: nameCorrect / results.length,
    parameterAccuracy: paramsCorrect / results.length,
    avgTokensUsed: totalTokens / results.length,
    avgInputTokens: totalInput / results.length,
    avgOutputTokens: totalOutput / results.length,
    avgDurationMs: totalDuration / results.length
  };
}

/**
 * Run the full benchmark
 */
async function runBenchmark(options: RunOptions = {}): Promise<BFCLReport> {
  const testCases = loadTestCases(options.limit);
  const systems = options.system === 'both' || !options.system
    ? ['vanilla', 'orchestrator'] as const
    : [options.system];

  console.log(`\nRunning BFCL benchmark on ${testCases.length} test cases...`);
  console.log(`Systems: ${systems.join(', ')}\n`);

  const allResults: BFCLResult[] = [];

  // Run each test case
  for (let i = 0; i < testCases.length; i++) {
    const testCase = testCases[i];
    console.log(`[${i + 1}/${testCases.length}] ${testCase.id}: ${testCase.question.substring(0, 60)}...`);

    for (const system of systems) {
      try {
        const result = await evaluateTestCase(testCase, system);
        allResults.push(result);

        const status = result.pass ? '✓ PASS' : '✗ FAIL';
        const details = result.error
          ? `ERROR: ${result.error}`
          : `${result.functionNameCorrect ? 'name✓' : 'name✗'} ${result.parametersCorrect ? 'params✓' : 'params✗'}`;

        console.log(`  ${system}: ${status} (${details}) [${result.tokensUsed} tokens, ${result.durationMs}ms]`);
      } catch (err) {
        console.error(`  ${system}: ERROR - ${err}`);
      }
    }
  }

  // Calculate statistics
  const vanillaResults = allResults.filter(r => r.system === 'vanilla');
  const orchestratorResults = allResults.filter(r => r.system === 'orchestrator');

  const vanillaStats = calculateStats(vanillaResults);
  const orchestratorStats = calculateStats(orchestratorResults);

  // Determine winner
  let winner: 'vanilla' | 'orchestrator' | 'tie' = 'tie';
  if (vanillaStats.passRate > orchestratorStats.passRate + 0.05) {
    winner = 'vanilla';
  } else if (orchestratorStats.passRate > vanillaStats.passRate + 0.05) {
    winner = 'orchestrator';
  }

  // Calculate cost efficiency
  const costEfficiencyRatio = vanillaStats.avgTokensUsed > 0
    ? orchestratorStats.avgTokensUsed / vanillaStats.avgTokensUsed
    : 0;

  const report: BFCLReport = {
    totalCases: testCases.length,
    results: {
      vanilla: vanillaStats,
      orchestrator: orchestratorStats
    },
    cases: allResults,
    costEfficiencyRatio,
    winner
  };

  return report;
}

/**
 * Pretty-print the report
 */
function printReport(report: BFCLReport): void {
  console.log('\n' + '='.repeat(80));
  console.log('BFCL BENCHMARK REPORT');
  console.log('='.repeat(80));
  console.log(`Total Test Cases: ${report.totalCases}`);
  console.log('');

  // Vanilla results
  console.log('VANILLA CLAUDE:');
  console.log(`  Pass Rate:              ${(report.results.vanilla.passRate * 100).toFixed(1)}%`);
  console.log(`  Function Name Accuracy: ${(report.results.vanilla.functionNameAccuracy * 100).toFixed(1)}%`);
  console.log(`  Parameter Accuracy:     ${(report.results.vanilla.parameterAccuracy * 100).toFixed(1)}%`);
  console.log(`  Avg Tokens Used:        ${report.results.vanilla.avgTokensUsed.toFixed(0)}`);
  console.log(`  Avg Input Tokens:       ${report.results.vanilla.avgInputTokens.toFixed(0)}`);
  console.log(`  Avg Output Tokens:      ${report.results.vanilla.avgOutputTokens.toFixed(0)}`);
  console.log(`  Avg Duration:           ${report.results.vanilla.avgDurationMs.toFixed(0)}ms`);
  console.log('');

  // Orchestrator results
  console.log('ORCHESTRATOR:');
  console.log(`  Pass Rate:              ${(report.results.orchestrator.passRate * 100).toFixed(1)}%`);
  console.log(`  Function Name Accuracy: ${(report.results.orchestrator.functionNameAccuracy * 100).toFixed(1)}%`);
  console.log(`  Parameter Accuracy:     ${(report.results.orchestrator.parameterAccuracy * 100).toFixed(1)}%`);
  console.log(`  Avg Tokens Used:        ${report.results.orchestrator.avgTokensUsed.toFixed(0)}`);
  console.log(`  Avg Input Tokens:       ${report.results.orchestrator.avgInputTokens.toFixed(0)}`);
  console.log(`  Avg Output Tokens:      ${report.results.orchestrator.avgOutputTokens.toFixed(0)}`);
  console.log(`  Avg Duration:           ${report.results.orchestrator.avgDurationMs.toFixed(0)}ms`);
  console.log('');

  // Comparison
  console.log('COMPARISON:');
  console.log(`  Winner:                 ${report.winner.toUpperCase()}`);
  console.log(`  Cost Efficiency Ratio:  ${report.costEfficiencyRatio.toFixed(2)}x`);
  console.log('  (Ratio of orchestrator tokens to vanilla tokens)');
  console.log('');

  console.log('='.repeat(80));
}

/**
 * Parse CLI arguments
 */
function parseArgs(args: string[]): RunOptions {
  const options: RunOptions = { system: 'both' };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--limit' && i + 1 < args.length) {
      options.limit = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--system' && i + 1 < args.length) {
      const sys = args[i + 1];
      if (sys === 'vanilla' || sys === 'orchestrator' || sys === 'both') {
        options.system = sys;
      }
      i++;
    } else if (arg === '--output' && i + 1 < args.length) {
      options.output = args[i + 1];
      i++;
    }
  }

  return options;
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  try {
    const report = await runBenchmark(options);
    printReport(report);

    // Save to file if specified
    if (options.output) {
      writeFileSync(options.output, JSON.stringify(report, null, 2));
      console.log(`\nReport saved to: ${options.output}`);
    }
  } catch (err) {
    console.error('Benchmark failed:', err);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { runBenchmark, printReport, loadTestCases };
