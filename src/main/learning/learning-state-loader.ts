import type {
  HabitTrackerStateSnapshot,
  MetricsCollectorStateSnapshot,
  OutcomeTrackerStateSnapshot,
} from './learning-state.types';

export async function loadOutcomeTrackerStateFromWorker(
  maxExperiences: number,
): Promise<OutcomeTrackerStateSnapshot | null> {
  try {
    const { getContextWorkerClient } = await import('../instance/context-worker-client');
    return await getContextWorkerClient().loadOutcomeTrackerState(maxExperiences);
  } catch {
    return null;
  }
}

export async function loadMetricsCollectorStateFromWorker(): Promise<MetricsCollectorStateSnapshot | null> {
  try {
    const { getContextWorkerClient } = await import('../instance/context-worker-client');
    return await getContextWorkerClient().loadMetricsCollectorState();
  } catch {
    return null;
  }
}

export async function loadHabitTrackerStateFromWorker(
  trackingWindowDays: number,
): Promise<HabitTrackerStateSnapshot | null> {
  try {
    const { getContextWorkerClient } = await import('../instance/context-worker-client');
    return await getContextWorkerClient().loadHabitTrackerState(trackingWindowDays);
  } catch {
    return null;
  }
}
