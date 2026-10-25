import { getWorkAdmission } from './work-admission';

interface QueueConfig { workerSlots: number; verificationSlots: number; maxLoadAverage: number }

/** Effective values are never written back into the run's saved settings. */
export function queueAdmission(config: QueueConfig, totalJobs: number, totalChecks: number) {
  const admission = getWorkAdmission();
  const limits = admission.getLimits();
  const workerSlots = Math.max(config.workerSlots, limits.queueWorkerMinimum ?? 0);
  const verificationSlots = Math.max(config.verificationSlots, limits.queueCheckMinimum ?? 0);
  return {
    workerSlots, verificationSlots,
    maxLoadAverage: Math.max(config.maxLoadAverage, limits.queueLoadMinimum ?? 0),
    canStartWorker: (runJobs: number): boolean => runJobs < workerSlots && admission.check('queue-job', { activeCount: totalJobs }).allowed,
    canStartCheck: (runChecks: number): boolean => runChecks < verificationSlots && admission.check('queue-check', { activeCount: totalChecks }).allowed,
    canStartTriage: (): boolean => admission.check('queue-triage').allowed,
  };
}
