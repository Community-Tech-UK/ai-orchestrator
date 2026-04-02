/**
 * Startup Optimizer - Parallelizes independent startup I/O.
 * Inspired by Claude Code's parallel startup patterns.
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('StartupOptimizer');

export type StartupPhase = 'immediate' | 'afterFirstRender' | 'onDemand';

export interface StartupTask {
  name: string;
  phase: StartupPhase;
  fn: () => Promise<unknown>;
  condition?: () => boolean;
}

export interface TaskResult {
  name: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

export class StartupOptimizer {
  private tasks: StartupTask[];
  private completedPhases = new Set<StartupPhase>();

  constructor(tasks: StartupTask[]) {
    this.tasks = tasks;
  }

  async runPhase(phase: StartupPhase): Promise<TaskResult[]> {
    if (this.completedPhases.has(phase)) {
      logger.warn('Phase already completed', { phase });
      return [];
    }

    const applicable = this.tasks.filter(t => t.phase === phase).filter(t => !t.condition || t.condition());

    logger.info('Running startup phase', { phase, taskCount: applicable.length });
    const startTime = Date.now();

    const results = await Promise.all(
      applicable.map(async (task): Promise<TaskResult> => {
        const taskStart = Date.now();
        try {
          await task.fn();
          return { name: task.name, success: true, durationMs: Date.now() - taskStart };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          logger.warn('Startup task failed', { task: task.name, error });
          return { name: task.name, success: false, durationMs: Date.now() - taskStart, error };
        }
      })
    );

    this.completedPhases.add(phase);
    logger.info('Phase completed', { phase, totalMs: Date.now() - startTime });
    return results;
  }

  getTasksByPhase(): Record<StartupPhase, string[]> {
    const result: Record<StartupPhase, string[]> = { immediate: [], afterFirstRender: [], onDemand: [] };
    for (const task of this.tasks) result[task.phase].push(task.name);
    return result;
  }
}
