import type { PlanQueueCheckWait } from '@contracts/schemas/plan-queue';
import { getWorkAdmission, type AdmissionDecision } from './work-admission';

interface QueueConfig { workerSlots: number; verificationSlots: number; maxLoadAverage: number }

function checkWait(decision: AdmissionDecision): PlanQueueCheckWait | null {
  if (decision.allowed) return null;
  if (decision.reason === 'computer-busy') return 'computer-busy';
  return decision.reason === 'over-limit' ? 'other-checks' : 'harness-held';
}

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
    /** Null when a check may start. */
    whyNoCheck: (runChecks: number): PlanQueueCheckWait | null => runChecks < verificationSlots
      ? checkWait(admission.check('queue-check', { activeCount: totalChecks })) : 'other-checks',
    whyNoChecklist: (running: number): PlanQueueCheckWait | null => checkWait(admission.check('queue-checklist', { activeCount: running })),
    canStartTriage: (): boolean => admission.check('queue-triage').allowed,
  };
}
