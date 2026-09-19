import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { PlanQueueRelaxation, RELAXABLE_SETTINGS, relaxedSettingsFor } from './plan-queue-relaxation';
import type { PlanQueueRun } from './plan-queue.types';

function fakeSettings(initial: Record<string, unknown>) {
  const values = new Map(Object.entries(initial));
  const writes: [string, unknown][] = [];
  return {
    values,
    writes,
    port: {
      get: (key: string) => values.get(key),
      set: (key: string, value: unknown) => { values.set(key, value); writes.push([key, value]); },
    },
  };
}

describe('PlanQueueRelaxation', () => {
  it('relaxes exactly the two approved settings', () => {
    expect(Object.keys(RELAXABLE_SETTINGS).sort()).toEqual(['computerUseAutonomyLevel', 'providersExcludedFromAutomation']);
  });

  it('snapshots before writing, applies, and restores', () => {
    const s = fakeSettings({ computerUseAutonomyLevel: 'guarded', providersExcludedFromAutomation: ['copilot'] });
    const relaxation = new PlanQueueRelaxation(s.port);
    const snapshot = relaxation.plan();
    expect(s.writes).toEqual([]);
    relaxation.apply(snapshot);
    expect(s.values.get('computerUseAutonomyLevel')).toBe('unrestricted');
    expect(s.values.get('providersExcludedFromAutomation')).toEqual([]);

    const result = relaxation.restore(snapshot);
    expect(result).toEqual({ restored: ['computerUseAutonomyLevel', 'providersExcludedFromAutomation'], leftAlone: [] });
    expect(s.values.get('computerUseAutonomyLevel')).toBe('guarded');
    expect(s.values.get('providersExcludedFromAutomation')).toEqual(['copilot']);
  });

  it('restores from a persisted snapshot after a simulated crash (fresh instance, JSON round trip)', () => {
    const s = fakeSettings({ computerUseAutonomyLevel: 'trusted', providersExcludedFromAutomation: ['copilot'] });
    const persisted = JSON.stringify(new PlanQueueRelaxation(s.port).plan());
    new PlanQueueRelaxation(s.port).apply(JSON.parse(persisted));

    const afterBoot = new PlanQueueRelaxation(s.port);
    afterBoot.restore(JSON.parse(persisted));
    expect(s.values.get('computerUseAutonomyLevel')).toBe('trusted');
    expect(s.values.get('providersExcludedFromAutomation')).toEqual(['copilot']);
  });

  it('leaves a setting James changed by hand during the run alone', () => {
    const s = fakeSettings({ computerUseAutonomyLevel: 'guarded', providersExcludedFromAutomation: ['copilot'] });
    const relaxation = new PlanQueueRelaxation(s.port);
    const snapshot = relaxation.plan();
    relaxation.apply(snapshot);
    s.values.set('computerUseAutonomyLevel', 'trusted');

    const result = relaxation.restore(snapshot);
    expect(result.leftAlone).toEqual(['computerUseAutonomyLevel']);
    expect(s.values.get('computerUseAutonomyLevel')).toBe('trusted');
    expect(s.values.get('providersExcludedFromAutomation')).toEqual(['copilot']);
  });

  it('rejects any other key, including in a tampered snapshot', () => {
    const s = fakeSettings({ allowPrCreation: false });
    const relaxation = new PlanQueueRelaxation(s.port);
    expect(() => relaxation.plan(['allowPrCreation'])).toThrow(/not relaxable/);
    expect(() => relaxation.apply({ entries: [{ key: 'allowPrCreation', original: false, applied: true }] })).toThrow(/not relaxable/);
    expect(s.writes).toEqual([]);
  });

  it('does not write a value that is already what the run wants', () => {
    const s = fakeSettings({ computerUseAutonomyLevel: 'unrestricted', providersExcludedFromAutomation: [] });
    const relaxation = new PlanQueueRelaxation(s.port);
    relaxation.apply(relaxation.plan());
    expect(s.writes).toEqual([]);
  });
});

describe('relaxedSettingsFor', () => {
  const run = (overrides: Partial<PlanQueueRun>): PlanQueueRun => ({
    id: 'r', parentInstanceId: 'p', kind: 'plans', workspaceCwd: '/repo', status: 'running',
    config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxSettings: true }, relaxation: null,
    workerProvider: null, workerModel: null, startedAt: 1, endedAt: null, ...overrides,
  });

  it('lists the holder snapshot keys, and every relaxable key for an active or paused sharer', () => {
    expect(relaxedSettingsFor(run({ relaxation: { entries: [{ key: 'computerUseAutonomyLevel', original: 'guarded', applied: 'unrestricted' }] } })))
      .toEqual(['computerUseAutonomyLevel']);
    expect(relaxedSettingsFor(run({}))).toEqual(Object.keys(RELAXABLE_SETTINGS));
    expect(relaxedSettingsFor(run({ status: 'paused' }))).toEqual(Object.keys(RELAXABLE_SETTINGS));
  });

  it('lists nothing for a finished run or one that did not ask for relaxation', () => {
    expect(relaxedSettingsFor(run({ status: 'completed' }))).toEqual([]);
    expect(relaxedSettingsFor(run({ status: 'cancelled' }))).toEqual([]);
    expect(relaxedSettingsFor(run({ config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxSettings: false } }))).toEqual([]);
  });
});
