/**
 * Task Loader - Loads benchmark tasks from JSON definition file
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { BenchmarkTask } from './types.js';

const TASKS_DIR = join(import.meta.dirname, 'tasks');
const TASK_SUITE_PATH = join(TASKS_DIR, 'task-suite.json');

export interface TaskSuite {
  version: string;
  description: string;
  tasks: BenchmarkTask[];
}

/**
 * Load all tasks from the task suite
 */
export function loadTaskSuite(): TaskSuite {
  if (!existsSync(TASK_SUITE_PATH)) {
    throw new Error(`Task suite not found at ${TASK_SUITE_PATH}`);
  }

  const content = readFileSync(TASK_SUITE_PATH, 'utf-8');
  const suite = JSON.parse(content) as TaskSuite;

  validateTaskSuite(suite);
  return suite;
}

/**
 * Load a single task by ID
 */
export function loadTask(taskId: string): BenchmarkTask | undefined {
  const suite = loadTaskSuite();
  return suite.tasks.find(t => t.id === taskId);
}

/**
 * Load tasks filtered by category
 */
export function loadTasksByCategory(category: BenchmarkTask['category']): BenchmarkTask[] {
  const suite = loadTaskSuite();
  return suite.tasks.filter(t => t.category === category);
}

/**
 * Load tasks filtered by complexity
 */
export function loadTasksByComplexity(complexity: BenchmarkTask['complexity']): BenchmarkTask[] {
  const suite = loadTaskSuite();
  return suite.tasks.filter(t => t.complexity === complexity);
}

/**
 * Validate the task suite structure
 */
function validateTaskSuite(suite: TaskSuite): void {
  if (!suite.version) {
    throw new Error('Task suite missing version');
  }
  if (!Array.isArray(suite.tasks)) {
    throw new Error('Task suite missing tasks array');
  }

  const ids = new Set<string>();
  for (const task of suite.tasks) {
    validateTask(task);
    if (ids.has(task.id)) {
      throw new Error(`Duplicate task ID: ${task.id}`);
    }
    ids.add(task.id);
  }
}

/**
 * Validate a single task definition
 */
function validateTask(task: BenchmarkTask): void {
  const required: (keyof BenchmarkTask)[] = [
    'id', 'name', 'category', 'complexity', 'prompt', 'workingDirectory', 'timeoutMinutes'
  ];

  for (const field of required) {
    if (task[field] === undefined || task[field] === null) {
      throw new Error(`Task ${task.id || '(unknown)'} missing required field: ${field}`);
    }
  }

  const validCategories = ['known-answer', 'real-codebase'];
  if (!validCategories.includes(task.category)) {
    throw new Error(`Task ${task.id} has invalid category: ${task.category}`);
  }

  const validComplexities = ['single-file', 'multi-file', 'large-context'];
  if (!validComplexities.includes(task.complexity)) {
    throw new Error(`Task ${task.id} has invalid complexity: ${task.complexity}`);
  }

  if (task.category === 'known-answer' && !task.expectedAnswer) {
    console.warn(`Warning: known-answer task ${task.id} has no expectedAnswer defined`);
  }

  if (task.timeoutMinutes <= 0 || task.timeoutMinutes > 30) {
    throw new Error(`Task ${task.id} has invalid timeout: ${task.timeoutMinutes} (must be 1-30)`);
  }
}

/**
 * Get the path to a setup script
 */
export function getSetupScriptPath(scriptName: string): string {
  return join(TASKS_DIR, 'setup', scriptName);
}
