/**
 * Shipped RTK auto-approve scope (A13, Step 18b item 1).
 *
 * The plan allows `'trial'` as the code default only after Live check 1 has
 * fully passed; until then the default is `'off'`. This pins what `'off'`
 * means end to end: no rewrite-only hook for auto-approve sessions or loops,
 * no trial eligibility, no rewrite-only env flag. Stored user values are read
 * as-is (no migration), which `rtk-rollout.spec.ts` covers per scope.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

const fake = vi.hoisted(() => ({ scope: 'off' as 'off' | 'trial' | 'on' | 'sessions-only' }));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp/aio-test-user-data' } }));
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../hooks/hook-path-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/hook-path-resolver')>();
  return { ...actual, ensureRtkDeferHookScript: () => '/tmp/rtk-defer-hook.mjs' };
});
vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({ rtkEnabled: true, rtkBundledOnly: false, rtkAutoApproveScope: fake.scope }),
  }),
}));
vi.mock('./rtk-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rtk-runtime')>();
  return {
    ...actual,
    getRtkRuntime: () => ({
      isAvailable: () => true,
      version: () => '0.51.0',
      binaryPath: () => '/bin/rtk',
      binarySource: () => 'bundled' as const,
      supportsRewrite: () => true,
      rewrite: () => ({ kind: 'passthrough' as const }),
    }),
  };
});

import { DEFAULT_SETTINGS } from '../../../shared/types/settings-defaults';
import { resolveBashHookCommand } from '../hooks/hook-path-resolver';
import {
  _resetRtkRolloutForTesting,
  buildClaudeRtkEnv,
  describeRtkCoverage,
  getAutomationRtk,
  resolveRtkSpawnConfig,
  shouldUseRtkYoloHook,
} from './rtk-rollout';

describe('shipped rtkAutoApproveScope default', () => {
  beforeEach(() => {
    _resetRtkRolloutForTesting();
    fake.scope = 'off';
  });

  const shipped = () => ({
    rtkEnabled: DEFAULT_SETTINGS.rtkEnabled,
    rtkBundledOnly: DEFAULT_SETTINGS.rtkBundledOnly,
    rtkAutoApproveScope: DEFAULT_SETTINGS.rtkAutoApproveScope,
  });

  it('ships off until Live check 1 has fully passed', () => {
    expect(DEFAULT_SETTINGS.rtkAutoApproveScope).toBe('off');
  });

  it('installs no rewrite-only hook for auto-approve sessions or loops under the shipped default', () => {
    expect(shouldUseRtkYoloHook(shipped().rtkAutoApproveScope, 'session', 'inst-1')).toBe(false);
    expect(shouldUseRtkYoloHook(shipped().rtkAutoApproveScope, 'loop', 'run-1')).toBe(false);

    const config = resolveRtkSpawnConfig(shipped(), 'session', 'inst-1');
    expect(config).toMatchObject({ enabled: true, rtkArm: 'n/a' });
    expect(config?.yoloHookPath).toBeUndefined();
    expect(config?.rtkTrialEligible).toBeUndefined();
    expect(config?.rtkTrialKey).toBeUndefined();

    // An auto-approve spawn then gets no PreToolUse Bash hook command at all.
    expect(resolveBashHookCommand({ yoloMode: true, rtk: config })).toBeUndefined();
    expect(buildClaudeRtkEnv({ yoloMode: true, rtk: config })['ORCHESTRATOR_RTK_REWRITE_ONLY']).toBeUndefined();

    // Loops read settings through the singleton and get nothing under 'off'.
    expect(getAutomationRtk('run-1')).toBeUndefined();
  });

  it('shows the auto-approve and loop surfaces as off under the shipped default', () => {
    const rows = describeRtkCoverage(shipped());
    expect(rows.find((r) => r.surface === 'Claude auto-approve')?.mode).toBe('Off');
    expect(rows.find((r) => r.surface === 'Loops')?.mode).toBe('Off');
  });

  it('still installs the hook when a user has chosen a stored non-off value', () => {
    const config = resolveRtkSpawnConfig({ ...shipped(), rtkAutoApproveScope: 'on' }, 'session', 'inst-1');
    expect(config?.yoloHookPath).toBe('/tmp/rtk-defer-hook.mjs');
    expect(resolveBashHookCommand({ yoloMode: true, rtk: config })).toContain('rtk-defer-hook.mjs');
    expect(buildClaudeRtkEnv({ yoloMode: true, rtk: config })['ORCHESTRATOR_RTK_REWRITE_ONLY']).toBe('1');
  });
});
