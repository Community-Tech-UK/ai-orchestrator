/**
 * Plan 18b item 4: the builder's `getRtkSpawnConfig(key)` must follow the
 * stored `rtkAutoApproveScope` setting on every call. The real builder and the
 * real rollout policy run; only the rtk binary probe, the hook script
 * resolver and Electron are stubbed. A builder that ignored the stored scope
 * (a constant `'off'`, or a constant `'trial'`/`'on'`) fails one of these.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SettingsManager } from '../../core/config/settings-manager';
import type { AppSettings } from '../../../shared/types/settings.types';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/harness', isPackaged: false } }));
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));
vi.mock('../../cli/hooks/hook-path-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cli/hooks/hook-path-resolver')>();
  return { ...actual, ensureRtkDeferHookScript: () => '/tmp/placeholder/rtk-defer-hook.mjs' };
});
vi.mock('../../cli/rtk/rtk-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cli/rtk/rtk-runtime')>();
  return {
    ...actual,
    getRtkRuntime: () => ({
      isAvailable: () => true,
      version: () => '0.51.0',
      binaryPath: () => '/placeholder/rtk',
      binarySource: () => 'bundled' as const,
      supportsRewrite: () => true,
      rewrite: () => ({ kind: 'passthrough' as const }),
    }),
  };
});

import { rtkArmFor, type RtkAutoApproveScope } from '../../cli/rtk/rtk-rollout';
import { SpawnConfigBuilder } from './spawn-config-builder';

function builderWith(stored: Partial<AppSettings>): SpawnConfigBuilder {
  const settings = { getAll: () => ({ rtkEnabled: true, rtkBundledOnly: false, ...stored }) } as unknown as SettingsManager;
  return new SpawnConfigBuilder({ settings });
}

/** First generated key that the trial hash puts in the requested arm. */
function keyInArm(arm: 'on' | 'off'): string {
  for (let i = 0; i < 1000; i += 1) {
    const key = `instance-${i}`;
    if (rtkArmFor(key, 'trial') === arm) return key;
  }
  throw new Error('no key found for arm');
}

describe('SpawnConfigBuilder.getRtkSpawnConfig follows the stored rtkAutoApproveScope', () => {
  it("stored 'on' gives the rewrite-only hook and the 'on' arm", () => {
    const config = builderWith({ rtkAutoApproveScope: 'on' }).getRtkSpawnConfig('instance-1');
    expect(config).toMatchObject({ enabled: true, rtkArm: 'on', yoloHookPath: '/tmp/placeholder/rtk-defer-hook.mjs' });
  });

  it.each<[string, Partial<AppSettings>]>([
    ["stored 'off'", { rtkAutoApproveScope: 'off' }],
    ['an unset scope', {}],
  ])('%s gives no hook and no trial arm', (_label, stored) => {
    const config = builderWith(stored).getRtkSpawnConfig('instance-1');
    expect(config).toMatchObject({ enabled: true, rtkArm: 'n/a' });
    expect(config?.yoloHookPath).toBeUndefined();
    expect(config?.rtkTrialEligible).toBeUndefined();
  });

  it("stored 'trial' splits by the session key: the on-arm key gets the hook, the off-arm key does not", () => {
    const builder = builderWith({ rtkAutoApproveScope: 'trial' });
    const onKey = keyInArm('on');
    const offKey = keyInArm('off');
    expect(builder.getRtkSpawnConfig(onKey)).toMatchObject({
      rtkArm: 'on', rtkTrialEligible: true, rtkTrialKey: onKey, yoloHookPath: '/tmp/placeholder/rtk-defer-hook.mjs',
    });
    const off = builder.getRtkSpawnConfig(offKey);
    expect(off).toMatchObject({ rtkArm: 'off', rtkTrialEligible: true, rtkTrialKey: offKey });
    expect(off?.yoloHookPath).toBeUndefined();
  });

  it('reads the setting on every call, so a changed scope applies to the next spawn', () => {
    let scope: RtkAutoApproveScope = 'off';
    const settings = { getAll: () => ({ rtkEnabled: true, rtkBundledOnly: false, rtkAutoApproveScope: scope }) } as unknown as SettingsManager;
    const builder = new SpawnConfigBuilder({ settings });
    expect(builder.getRtkSpawnConfig('instance-1')?.yoloHookPath).toBeUndefined();
    scope = 'on';
    expect(builder.getRtkSpawnConfig('instance-1')?.yoloHookPath).toBeDefined();
  });
});
