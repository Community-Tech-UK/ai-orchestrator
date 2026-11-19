import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ on: false, placed: 'local' as 'local' | 'remote', config: undefined as unknown }));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ get: (key: string) => (key === 'preferOtherComputers' ? settings.on : key === 'defaultCli' ? 'claude' : undefined) }),
}));
vi.mock('../instance/lifecycle/default-computer-placement', () => ({
  resolveNewSessionPlacement: (config: unknown) => {
    settings.config = config;
    return { location: settings.placed === 'remote' ? { type: 'remote', nodeId: 'pc' } : { type: 'local' } };
  },
}));

import { automationPrefersOtherComputer, automationRunsOnOtherComputer } from './automation-computer-preference';
import type { AutomationAction } from '../../shared/types/automation.types';

const action = (extra: Partial<AutomationAction> = {}): AutomationAction => ({ prompt: 'Check', workingDirectory: '/tmp', ...extra });

describe('automationPrefersOtherComputer', () => {
  beforeEach(() => { settings.on = true; settings.placed = 'local'; });

  it('asks only when the setting is on', () => {
    expect(automationPrefersOtherComputer(action())).toBe(true);
    settings.on = false;
    expect(automationPrefersOtherComputer(action())).toBe(false);
  });

  it.each([
    ['a named computer', { forceNodeId: 'windows-pc' }],
    ['a contained run', { executionProfile: 'contained' as const }],
    ['an authority grant', { executionAuthority: {} as never }],
    ['a system resume', { systemAction: { type: 'loopProviderLimitResume' as const, loopRunId: 'loop' } }],
    ['a loop', { loop: {} as never }],
  ])('never asks for %s', (_name, extra) => {
    expect(automationPrefersOtherComputer(action(extra))).toBe(false);
  });

  describe('automationRunsOnOtherComputer', () => {
    const defaults = { automationDefaultCli: 'auto', automationDefaultModel: 'auto', modelPickerFavorites: [] } as never;

    it('is true for a named computer whatever the setting says', () => {
      settings.on = false;
      expect(automationRunsOnOtherComputer(action({ forceNodeId: 'windows-pc' }), defaults)).toBe(true);
    });

    it('is true only when the job asks and a computer can take it now', () => {
      expect(automationRunsOnOtherComputer(action(), defaults)).toBe(false);
      settings.placed = 'remote';
      expect(automationRunsOnOtherComputer(action(), defaults)).toBe(true);
      settings.on = false;
      expect(automationRunsOnOtherComputer(action(), defaults)).toBe(false);
    });

    it("reads the placement with the run's model and its never-use and use-last lists", () => {
      automationRunsOnOtherComputer(action({ provider: 'claude', model: 'claude-opus-4' } as Partial<AutomationAction>), defaults, { avoid: ['a'], last: ['b'] });
      expect(settings.config).toMatchObject({ provider: 'claude', accountRouteOrigin: 'automation', accountPreferences: { avoid: ['a'], last: ['b'] } });
    });
  });
});
