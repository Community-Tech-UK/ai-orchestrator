import type { WorkloadLevel } from '../../shared/types/workload-settings.types';

export interface WorkloadLimits {
  queueJobs: number | null;
  queueChecks: number | null;
  helperAgents: number | null;
  loopRounds: number | null;
  scheduledJobs: number | null;
  backgroundConcurrent: number | null;
  backgroundMultiplier: number | null;
  loadPerCore: number | null;
  queueWorkerMinimum: number | null;
  queueCheckMinimum: number | null;
  queueLoadMinimum: number | null;
}

/** Null means preserve the engine's existing policy, including Balanced's load gate. */
export function limitsFor(level: WorkloadLevel, cpuCount: number): WorkloadLimits {
  const limits: WorkloadLimits = {
    queueJobs: null, queueChecks: null, helperAgents: null, loopRounds: null,
    scheduledJobs: null, backgroundConcurrent: null, backgroundMultiplier: null,
    loadPerCore: null, queueWorkerMinimum: null, queueCheckMinimum: null, queueLoadMinimum: null,
  };
  if (level <= 2) return {
    ...limits, queueJobs: level, queueChecks: 1, helperAgents: level * 2,
    loopRounds: level, scheduledJobs: level, backgroundConcurrent: level === 1 ? 0 : 1,
    loadPerCore: level === 1 ? 0.75 : 1,
  };
  if (level >= 4) return {
    ...limits, queueWorkerMinimum: level, queueCheckMinimum: level - 2,
    queueLoadMinimum: Math.max(1, cpuCount) * (level === 4 ? 2.5 : 3),
    backgroundMultiplier: level === 5 ? 2 : null,
  };
  return limits;
}
