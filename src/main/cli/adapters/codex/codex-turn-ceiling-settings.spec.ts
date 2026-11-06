import { afterEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ failure: new Error('no settings store') as Error | null }));
vi.mock('../../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => { if (settings.failure) throw settings.failure; return { codexTurnCeilingHarnessWorkStopTokens: 7 }; } }),
}));

import { readAppSettings } from './codex-turn-ceiling-controller';
import { resolveCodexTurnCeilingPolicy } from './codex-turn-token-ceiling';

describe('round limits when the settings store cannot be read', () => {
  afterEach(() => { settings.failure = new Error('no settings store'); vi.unstubAllGlobals(); });

  it('reads the stored limits when the store answers', () => {
    settings.failure = null;
    expect(readAppSettings()).toMatchObject({ codexTurnCeilingHarnessWorkStopTokens: 7 });
  });

  it('applies no limit on a remote worker, which has no store and no controller snapshot', () => {
    const policy = resolveCodexTurnCeilingPolicy('plan-queue', readAppSettings());
    expect(policy).toMatchObject({ wrapUpAt: 0, stopAt: 0 });
    expect(resolveCodexTurnCeilingPolicy('chat', readAppSettings())).toMatchObject({ wrapUpAt: 0, stopAt: 0 });
  });

  it('keeps the built-in thresholds in Electron main, where an unreadable store must not remove the protection', () => {
    vi.stubGlobal('process', Object.create(process, {
      versions: { value: { ...process.versions, electron: '42.0.0' } },
      type: { value: 'browser' },
    }));
    expect(readAppSettings()).toBeUndefined();
    expect(resolveCodexTurnCeilingPolicy('plan-queue', readAppSettings())).toMatchObject({ wrapUpAt: 150_000_000, stopAt: 300_000_000 });
  });
});
