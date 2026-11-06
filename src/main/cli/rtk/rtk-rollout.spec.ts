/**
 * RTK rollout policy (A13, Steps 18a/18b).
 *
 * Covers the settings-keyed eligibility memo (not a process-wide cache), the
 * pure trial-arm hash, the coverage table, and the env block. The rtk runtime
 * is faked so no test probes a real binary.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

const fakeRuntime = vi.hoisted(() => ({
  available: true,
  version: '0.51.0' as string | null,
  hookAvailable: true,
  scope: 'trial' as 'off' | 'trial' | 'on' | 'sessions-only',
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../hooks/hook-path-resolver', () => ({
  ensureRtkDeferHookScript: () => {
    if (!fakeRuntime.hookAvailable) throw new Error('hook missing');
    return '/tmp/rtk-defer-hook.mjs';
  },
}));
vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({ rtkEnabled: true, rtkBundledOnly: false, rtkAutoApproveScope: fakeRuntime.scope }),
  }),
}));
vi.mock('./rtk-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rtk-runtime')>();
  return {
    ...actual,
    getRtkRuntime: () => ({
      isAvailable: () => fakeRuntime.available,
      version: () => fakeRuntime.version,
      binaryPath: () => '/bin/rtk',
      binarySource: () => 'bundled' as const,
      supportsRewrite: () => actual.supportsRewriteVersion(fakeRuntime.version),
      rewrite: () => ({ kind: 'passthrough' as const }),
    }),
  };
});

import {
  _resetRtkRolloutForTesting,
  buildClaudeRtkEnv,
  describeRtkCoverage,
  getAutomationRtk,
  isRtkHookEligible,
  resolveRtkSpawnConfig,
  rtkArmFor,
  stampRtkArm,
  shouldUseRtkYoloHook,
  type RtkRolloutSettings,
} from './rtk-rollout';

describe('isRtkHookEligible', () => {
  beforeEach(() => {
    _resetRtkRolloutForTesting();
    fakeRuntime.available = true;
    fakeRuntime.version = '0.51.0';
    fakeRuntime.hookAvailable = true;
    fakeRuntime.scope = 'trial';
  });

  it('is false when the setting is off and true when on with a rewrite-capable binary', () => {
    expect(isRtkHookEligible({ rtkEnabled: false, rtkBundledOnly: false })).toBe(false);
    expect(isRtkHookEligible({ rtkEnabled: true, rtkBundledOnly: false })).toBe(true);
  });

  it('is recomputed when rtkEnabled flips (not a process-wide cache)', () => {
    expect(isRtkHookEligible({ rtkEnabled: true, rtkBundledOnly: false })).toBe(true);
    expect(isRtkHookEligible({ rtkEnabled: false, rtkBundledOnly: false })).toBe(false);
    expect(isRtkHookEligible({ rtkEnabled: true, rtkBundledOnly: false })).toBe(true);
  });

  it('is false for a binary below the rewrite floor and for an unavailable binary', () => {
    fakeRuntime.version = '0.42.4';
    _resetRtkRolloutForTesting();
    expect(isRtkHookEligible({ rtkEnabled: true, rtkBundledOnly: false })).toBe(false);
    fakeRuntime.version = '0.51.0';
    fakeRuntime.hookAvailable = true;
    fakeRuntime.scope = 'trial';
    fakeRuntime.available = false;
    _resetRtkRolloutForTesting();
    expect(isRtkHookEligible({ rtkEnabled: true, rtkBundledOnly: false })).toBe(false);
  });
});

describe('rtkArmFor', () => {
  it('is stable for a key and matches the scope', () => {
    expect(rtkArmFor('inst-1', 'off')).toBe('off');
    expect(rtkArmFor('inst-1', 'on')).toBe('on');
    expect(rtkArmFor('inst-1', 'sessions-only')).toBe('on');
    const trial1 = rtkArmFor('inst-trial-1', 'trial');
    const trial2 = rtkArmFor('inst-trial-1', 'trial');
    expect(trial1).toBe(trial2);
    expect(['on', 'off']).toContain(trial1);
    expect(rtkArmFor(undefined, 'trial')).toBe('off');
  });

  it('splits 10,000 keys within 48 to 52 percent', () => {
    let on = 0;
    for (let i = 0; i < 10_000; i += 1) {
      if (rtkArmFor(`inst-${i}`, 'trial') === 'on') on += 1;
    }
    expect(on / 10_000).toBeGreaterThanOrEqual(0.48);
    expect(on / 10_000).toBeLessThanOrEqual(0.52);
  });
});

describe('shouldUseRtkYoloHook', () => {
  it('follows the scope and surface', () => {
    expect(shouldUseRtkYoloHook('off', 'session', 'k')).toBe(false);
    expect(shouldUseRtkYoloHook('on', 'session', 'k')).toBe(true);
    expect(shouldUseRtkYoloHook('on', 'loop', 'k')).toBe(true);
    expect(shouldUseRtkYoloHook('sessions-only', 'session', 'k')).toBe(true);
    expect(shouldUseRtkYoloHook('sessions-only', 'loop', 'k')).toBe(false);
  });
});

describe('resolveRtkSpawnConfig', () => {
  beforeEach(() => {
    _resetRtkRolloutForTesting();
    fakeRuntime.available = true;
    fakeRuntime.version = '0.51.0';
  });

  const settings = (overrides: Partial<RtkRolloutSettings> = {}): RtkRolloutSettings => ({
    rtkEnabled: true,
    rtkBundledOnly: false,
    rtkAutoApproveScope: 'trial',
    ...overrides,
  });

  it('installs the hook only where the scope allows, and always reports the arm', () => {
    const on = resolveRtkSpawnConfig(settings({ rtkAutoApproveScope: 'on' }), 'session', 'inst-1');
    expect(on?.yoloHookPath).toBe('/tmp/rtk-defer-hook.mjs');
    expect(on?.rtkArm).toBe('on');

    const sessionsOnlyLoop = resolveRtkSpawnConfig(
      settings({ rtkAutoApproveScope: 'sessions-only' }), 'loop', 'run-1',
    );
    expect(sessionsOnlyLoop?.yoloHookPath).toBeUndefined();
    expect(sessionsOnlyLoop?.rtkArm).toBe('n/a');

    const trial = resolveRtkSpawnConfig(settings(), 'session', 'inst-2');
    expect(trial?.rtkArm).toBe('on');
    expect(trial?.binaryPath).toBe('/bin/rtk');
  });

  it('is undefined when the setting is off or the binary cannot speak the protocol', () => {
    expect(resolveRtkSpawnConfig(settings({ rtkEnabled: false }), 'session', 'k')).toBeUndefined();
    fakeRuntime.version = '0.42.4';
    _resetRtkRolloutForTesting();
    expect(resolveRtkSpawnConfig(settings(), 'session', 'k')).toBeUndefined();
  });

  it('retains the off loop arm as an eligible control without installing a hook', () => {
    fakeRuntime.scope = 'trial';
    const off = getAutomationRtk('inst-1');
    expect(off).toMatchObject({ rtkArm: 'off', rtkTrialEligible: true, rtkTrialKey: 'inst-1' });
    expect(off?.yoloHookPath).toBeUndefined();
    fakeRuntime.scope = 'sessions-only';
    expect(getAutomationRtk('inst-1')).toBeUndefined();
  });

  it('stamps only eligible Claude auto-approve local spawns and clears stale arm metadata', () => {
    const on = resolveRtkSpawnConfig(settings(), 'session', 'inst-2');
    const instance = { yoloMode: true, metadata: {} as Record<string, unknown> };
    stampRtkArm(instance, on, 'claude', true);
    expect(instance.metadata).toMatchObject({ rtkArm: 'on', rtkTrialEligible: true, rtkTrialKey: 'inst-2' });
    stampRtkArm(instance, on, 'codex', true);
    expect(instance.metadata['rtkTrialEligible']).toBeUndefined();
    expect(instance.metadata['rtkArm']).toBeUndefined();
    instance.yoloMode = false;
    stampRtkArm(instance, on, 'claude', true);
    expect(instance.metadata['rtkArm']).toBeUndefined();
    instance.yoloMode = true;
    stampRtkArm(instance, on, 'claude', false);
    expect(instance.metadata['rtkArm']).toBeUndefined();
  });

  it('keeps an instance quarantined after an eligible, ordinary, eligible transition', () => {
    const on = resolveRtkSpawnConfig(settings(), 'session', 'inst-2');
    const instance = { yoloMode: true, metadata: {} as Record<string, unknown> };
    stampRtkArm(instance, on, 'claude', true);
    expect(instance.metadata['rtkTrialEligible']).toBe(true);
    instance.yoloMode = false;
    stampRtkArm(instance, on, 'claude', true);
    expect(instance.metadata).toMatchObject({ rtkTrialKey: 'inst-2' });
    expect(instance.metadata['rtkTrialEligible']).toBeUndefined();
    instance.yoloMode = true;
    stampRtkArm(instance, on, 'claude', true);
    expect(instance.metadata['rtkTrialEligible']).toBeUndefined();

    const changedProvider = { yoloMode: true, metadata: {} as Record<string, unknown> };
    stampRtkArm(changedProvider, on, 'claude', true);
    stampRtkArm(changedProvider, on, 'codex', true);
    stampRtkArm(changedProvider, on, 'claude', true);
    expect(changedProvider.metadata['rtkTrialEligible']).toBeUndefined();
  });

  it('does not label an on arm eligible when hook resolution failed', () => {
    fakeRuntime.hookAvailable = false;
    const on = resolveRtkSpawnConfig(settings(), 'session', 'inst-2');
    expect(on?.rtkArm).toBe('on');
    expect(on?.rtkTrialEligible).toBeUndefined();
    const instance = { yoloMode: true, metadata: {} as Record<string, unknown> };
    stampRtkArm(instance, on, 'claude', true);
    expect(instance.metadata['rtkArm']).toBeUndefined();
  });

  it('preserves an older partial spawn config without admitting an unresolved binary to the trial', () => {
    const config = { enabled: true, rtkArm: 'on' as const, rtkTrialEligible: true,
      rtkTrialKey: 'inst-2', yoloHookPath: '/fixture/hook.mjs' };
    const instance = { yoloMode: true, metadata: {} as Record<string, unknown> };
    expect(stampRtkArm(instance, config, 'claude', true)).toBe(config);
    expect(instance.metadata['rtkTrialEligible']).toBeUndefined();
  });
});

describe('buildClaudeRtkEnv', () => {
  it('sets the rewrite-only variable only for auto-approve with a hook path', () => {
    const base = { enabled: true, binaryPath: '/bin/rtk' };
    expect(buildClaudeRtkEnv({ yoloMode: true, rtk: { ...base, yoloHookPath: '/h.mjs' } }))
      .toMatchObject({ ORCHESTRATOR_RTK_REWRITE_ONLY: '1' });
    expect(buildClaudeRtkEnv({ yoloMode: false, rtk: { ...base, yoloHookPath: '/h.mjs' } }))
      .not.toHaveProperty('ORCHESTRATOR_RTK_REWRITE_ONLY');
    expect(buildClaudeRtkEnv({ yoloMode: true, rtk: base }))
      .not.toHaveProperty('ORCHESTRATOR_RTK_REWRITE_ONLY');
    expect(buildClaudeRtkEnv({ yoloMode: true, rtk: undefined })).toEqual({});
  });

  it('carries the telemetry opt-out and the binary path', () => {
    const env = buildClaudeRtkEnv({ rtk: { enabled: true, binaryPath: '/bin/rtk' } });
    expect(env).toEqual({
      ORCHESTRATOR_RTK_ENABLED: '1',
      ORCHESTRATOR_RTK_PATH: '/bin/rtk',
      RTK_TELEMETRY_DISABLED: '1',
    });
  });
});

describe('describeRtkCoverage', () => {
  beforeEach(() => {
    _resetRtkRolloutForTesting();
    fakeRuntime.available = true;
    fakeRuntime.version = '0.51.0';
  });

  const settings = (overrides: Partial<RtkRolloutSettings> = {}): RtkRolloutSettings => ({
    rtkEnabled: true,
    rtkBundledOnly: false,
    rtkAutoApproveScope: 'trial',
    ...overrides,
  });

  it('has a row for every surface the plan names', () => {
    const rows = describeRtkCoverage(settings());
    expect(rows.map((r) => r.surface)).toEqual([
      'Claude asking for approval',
      'Claude auto-approve',
      'Loops',
      'Codex',
      'Copilot, Cursor, OpenCode, Grok',
      'Antigravity and Gemini',
      'Remote machines',
    ]);
    for (const row of rows) {
      expect(row.note.length).toBeGreaterThan(10);
    }
  });

  it('reports the scope on the two auto-approve surfaces', () => {
    const trial = describeRtkCoverage(settings({ rtkAutoApproveScope: 'trial' }));
    expect(trial.find((r) => r.surface === 'Claude auto-approve')?.mode).toBe('Trial');
    expect(trial.find((r) => r.surface === 'Loops')?.mode).toBe('Trial');

    const sessionsOnly = describeRtkCoverage(settings({ rtkAutoApproveScope: 'sessions-only' }));
    expect(sessionsOnly.find((r) => r.surface === 'Claude auto-approve')?.mode).toBe('Hook');
    expect(sessionsOnly.find((r) => r.surface === 'Loops')?.mode).toBe('Off');

    const off = describeRtkCoverage(settings({ rtkAutoApproveScope: 'off' }));
    expect(off.find((r) => r.surface === 'Claude auto-approve')?.mode).toBe('Off');
  });

  it('keeps hookless agents on instructions and remote machines off', () => {
    const rows = describeRtkCoverage(settings());
    expect(rows.find((r) => r.surface === 'Codex')?.mode).toBe('Instructions only');
    expect(rows.find((r) => r.surface === 'Remote machines')?.mode).toBe('Off');
    const disabled = describeRtkCoverage(settings({ rtkEnabled: false }));
    expect(disabled.find((r) => r.surface === 'Codex')?.mode).toBe('Off');
  });
});
