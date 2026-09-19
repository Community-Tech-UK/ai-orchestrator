/**
 * Plan Queue relaxation profile — the per-run settings overrides James
 * approved (review decision 1, option c): exactly two operator-only settings.
 *
 * Lifecycle: `plan()` reads the current values into a snapshot, the caller
 * persists it on the run row, then `apply()` writes the relaxed values. At run
 * end, and on every boot, `restore()` puts each original back — but only when
 * the setting still holds the value the run applied. A value James changed by
 * hand during the run is his decision and is left alone.
 *
 * These keys are operator-only for agent, MCP and CLI writers
 * (settings-control-policy.ts). This is a main-process SettingsManager write
 * made by the coordinator on James's explicit opt-in, which that policy does
 * not govern; SettingsManager emits its usual change events for it.
 */

import { getLogger } from '../logging/logger';
import type { PlanQueueRelaxationSnapshot, PlanQueueRun } from './plan-queue.types';

const logger = getLogger('PlanQueueRelaxation');

/** The only settings a run may relax, and the value each is relaxed to. */
export const RELAXABLE_SETTINGS: Readonly<Record<string, unknown>> = {
  // Lets a livetest worker drive local UI without per-action approval prompts.
  computerUseAutonomyLevel: 'unrestricted',
  // Lets automatic selection (workers, verifiers) use every installed provider.
  providersExcludedFromAutomation: [],
};

export interface RelaxationSettingsPort {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export interface RestoreResult {
  restored: string[];
  /** Keys James changed by hand during the run, left as he set them. */
  leftAlone: string[];
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The settings relaxed for a run. The one active run holding the snapshot
 * lists its entries; any other active run with `relaxSettings` shares the
 * settings already in force (the coordinator keeps a holder while any such run
 * is active), so it lists every relaxable key. Finished runs list none.
 */
export function relaxedSettingsFor(run: PlanQueueRun): string[] {
  if (run.relaxation) return run.relaxation.entries.map((entry) => entry.key);
  const active = run.status === 'running' || run.status === 'paused';
  return active && run.config.relaxSettings ? Object.keys(RELAXABLE_SETTINGS) : [];
}

export function assertRelaxable(key: string): void {
  if (!Object.prototype.hasOwnProperty.call(RELAXABLE_SETTINGS, key)) {
    throw new Error(`Setting ${key} is not relaxable by the Plan Queue`);
  }
}

export class PlanQueueRelaxation {
  constructor(private readonly settings: RelaxationSettingsPort) {}

  /** Snapshot current values. Nothing is written yet. */
  plan(keys: readonly string[] = Object.keys(RELAXABLE_SETTINGS)): PlanQueueRelaxationSnapshot {
    return {
      entries: keys.map((key) => {
        assertRelaxable(key);
        return { key, original: this.settings.get(key), applied: RELAXABLE_SETTINGS[key] };
      }),
    };
  }

  /** Write the relaxed values. Call only after the snapshot is persisted. */
  apply(snapshot: PlanQueueRelaxationSnapshot): void {
    for (const entry of snapshot.entries) {
      assertRelaxable(entry.key);
      if (sameValue(this.settings.get(entry.key), entry.applied)) continue;
      this.settings.set(entry.key, entry.applied);
      logger.info('Plan queue relaxed a setting for its run', { key: entry.key });
    }
  }

  restore(snapshot: PlanQueueRelaxationSnapshot): RestoreResult {
    const result: RestoreResult = { restored: [], leftAlone: [] };
    for (const entry of snapshot.entries) {
      assertRelaxable(entry.key);
      const current = this.settings.get(entry.key);
      if (sameValue(current, entry.original)) continue;
      if (!sameValue(current, entry.applied)) {
        result.leftAlone.push(entry.key);
        logger.info('Plan queue left a relaxed setting alone: it was changed during the run', { key: entry.key });
        continue;
      }
      this.settings.set(entry.key, entry.original);
      result.restored.push(entry.key);
      logger.info('Plan queue restored a relaxed setting', { key: entry.key });
    }
    return result;
  }
}
