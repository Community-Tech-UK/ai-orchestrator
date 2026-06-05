import type { InstanceManager } from '../instance/instance-manager';
import type { AutomationRun } from '../../shared/types/automation.types';
import type { AutomationStore } from './automation-store';
import type { ThreadWakeupRunner } from './thread-wakeup-runner';

export type ThreadWakeupRunnerFactory = (
  manager: InstanceManager,
  store: AutomationStore,
  now: () => number,
) => ThreadWakeupRunner;

/**
 * Callback registered by the scheduler so the runner can schedule a retry
 * without a circular dependency.  The scheduler is the sole owner of timers.
 */
export type RetrySchedulerCallback = (
  originalRun: AutomationRun,
  nextAttempt: number,
  maxAttempts: number,
  delayMs: number,
) => void;
