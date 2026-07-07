/**
 * Orchestrator Executor - Runs tasks using AI Orchestrator in headless mode
 *
 * Uses the headless driver to import orchestrator services directly,
 * bypassing Electron. This allows benchmarking the full orchestrator stack
 * (child spawning, context compaction, RLM) from the command line.
 */

import { OrchestratorDriver } from './headless/orchestrator-driver.js';
import type { BenchmarkTask, ExecutorResult } from '../types.js';

export interface OrchestratorExecutorOptions {
  /** Pre-filled context messages to send before the task */
  contextMessages?: string[];
  /** Maximum time to wait in milliseconds */
  timeoutMs?: number;
}

/**
 * Execute a task using AI Orchestrator (headless mode)
 */
export async function executeOrchestrator(
  task: BenchmarkTask,
  options: OrchestratorExecutorOptions = {}
): Promise<ExecutorResult> {
  const driver = new OrchestratorDriver();
  return driver.execute(task, options);
}
