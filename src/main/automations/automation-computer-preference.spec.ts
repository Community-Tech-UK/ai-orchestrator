import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  on: false, placed: 'local' as 'local' | 'remote', config: undefined as unknown, mightWait: false,
  useThisMac: true, machines: [] as { host: string; nodeName: string | null; platform: 'darwin' | 'linux' }[], nodes: [] as { id: string; name: string }[],
}));
vi.mock('../computers/test-machine-file', () => ({
  readUseThisMac: () => settings.useThisMac,
  readTestMachines: () => settings.machines,
}));
vi.mock('../remote-node/worker-node-registry', () => ({ getWorkerNodeRegistry: () => ({ getHealthyNodes: () => settings.nodes }) }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ get: (key: string) => (key === 'preferOtherComputers' ? settings.on : key === 'defaultCli' ? 'claude' : undefined) }),
}));
vi.mock('../instance/lifecycle/default-computer-placement', () => ({
  resolveNewSessionPlacement: (config: unknown) => {
    settings.config = config;
    return {
      location: settings.placed === 'remote' ? { type: 'remote', nodeId: 'pc' } : { type: 'local' },
      ...(settings.mightWait ? { stayedHereBecause: 'the test Mac is away', mightWaitForComputer: true } : {}),
    };
  },
}));

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automationComputerRule, automationPrefersOtherComputer, automationRunsOnOtherComputer, automationWaitReason } from './automation-computer-preference';
import type { AutomationAction } from '../../shared/types/automation.types';

const action = (extra: Partial<AutomationAction> = {}): AutomationAction => ({ prompt: 'Check', workingDirectory: '/tmp', ...extra });

describe('automationPrefersOtherComputer', () => {
  beforeEach(() => { settings.on = true; settings.placed = 'local'; settings.mightWait = false; settings.useThisMac = true; settings.machines = []; settings.nodes = []; });

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

describe('with "Use this Mac when the others are busy or away" off', () => {
  const defaults = { automationDefaultCli: 'auto', automationDefaultModel: 'auto', modelPickerFavorites: [] } as never;
  const testMac = { host: 'ct-test-mac', nodeName: null, platform: 'darwin' as const };
  let folder: string;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'automation-rule-'));
    settings.useThisMac = false;
    settings.on = false;
    settings.machines = [testMac, { host: 'pc', nodeName: 'windows-pc', platform: 'linux' }];
    settings.nodes = [{ id: 'mac-id', name: 'ct-test-mac' }, { id: 'pc-id', name: 'windows-pc' }, { id: 'noah-id', name: 'noahlaptop' }];
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('limits a plain job to the connected test Mac, never the PC or another computer', () => {
    expect(automationComputerRule(action({ workingDirectory: folder }))).toEqual({ onlyNodeIds: ['mac-id'] });
  });

  it('names a test machine by its paired name when it has one', () => {
    settings.machines = [{ host: 'short', nodeName: 'ct-test-mac', platform: 'darwin' }];
    expect(automationComputerRule(action({ workingDirectory: folder }))).toEqual({ onlyNodeIds: ['mac-id'] });
  });

  it('allows no computer when the test Mac is not connected, so the job waits for it', () => {
    settings.nodes = [{ id: 'pc-id', name: 'windows-pc' }];
    expect(automationComputerRule(action({ workingDirectory: folder }))).toEqual({ onlyNodeIds: [] });
  });

  it('keeps a job in a Git repository here, and says why, because nothing sends a repository out for it', () => {
    mkdirSync(join(folder, '.git'));
    mkdirSync(join(folder, 'sub'));
    expect(automationComputerRule(action({ workingDirectory: join(folder, 'sub') }))).toMatchObject({ stayHere: expect.stringContaining('Git repository') });
  });

  it('keeps every job here, and says why, when no test Mac is set up', () => {
    settings.machines = [{ host: 'pc', nodeName: 'windows-pc', platform: 'linux' }];
    expect(automationComputerRule(action({ workingDirectory: folder }))).toMatchObject({ stayHere: expect.stringContaining('no test Mac') });
  });

  it('applies no rule when the switch is on', () => {
    settings.useThisMac = true;
    expect(automationComputerRule(action({ workingDirectory: folder }))).toBeUndefined();
  });

  it('asks for another computer whatever the setting says, except for jobs that never ask', () => {
    expect(automationPrefersOtherComputer(action({ workingDirectory: folder }))).toBe(true);
    expect(automationPrefersOtherComputer(action({ workingDirectory: folder, forceNodeId: 'windows-pc' }))).toBe(false);
    expect(automationPrefersOtherComputer(action({ workingDirectory: folder, executionProfile: 'contained' }))).toBe(false);
  });

  it('passes the rule to the placement it reads', () => {
    automationRunsOnOtherComputer(action({ workingDirectory: folder }), defaults);
    expect(settings.config).toMatchObject({ computerRule: { onlyNodeIds: ['mac-id'] } });
  });

  it('waits only when the placement says the computers are busy, paused or away', () => {
    expect(automationWaitReason(action({ workingDirectory: folder }), defaults)).toBeNull();
    settings.mightWait = true;
    expect(automationWaitReason(action({ workingDirectory: folder }), defaults)).toBe('Waiting for the test Mac: the test Mac is away');
    settings.useThisMac = true;
    expect(automationWaitReason(action({ workingDirectory: folder }), defaults)).toBeNull();
  });

  it('never waits for a job pinned to a computer', () => {
    settings.mightWait = true;
    expect(automationWaitReason(action({ workingDirectory: folder, forceNodeId: 'windows-pc' }), defaults)).toBeNull();
  });
});
