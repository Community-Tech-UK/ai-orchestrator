import { getWorkAdmission } from './work-admission';

export function backgroundConcurrency(base: number): number {
  const limits = getWorkAdmission().getLimits();
  return limits.backgroundConcurrent ?? base * (limits.backgroundMultiplier ?? 1);
}

export function backgroundConcurrencySetting(raw: unknown, fallback: number): number {
  return backgroundConcurrency(typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.max(1, Math.floor(raw)) : fallback);
}

export function bindBackgroundAdmission(active: () => number, drain: () => Promise<void>): () => void {
  const admission = getWorkAdmission();
  const unregister = admission.registerCounter('background-index', active);
  const changed = (): void => { void drain(); };
  admission.on('admission-changed', changed);
  return () => { admission.off('admission-changed', changed); unregister(); };
}
