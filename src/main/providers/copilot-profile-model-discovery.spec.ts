import { describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('./copilot/copilot-account-routing-service', () => ({
  getCopilotAccountRoutingService: () => ({ listProfiles: () => [] }),
}));

import type { CopilotModelInfo } from '../cli/adapters/copilot-cli-adapter.types';
import type { CopilotAccountProfile } from '../../shared/types/copilot-account.types';
import {
  copilotDiscoveryTargets,
  listCopilotModelsAcrossProfiles,
  type CopilotProfileDiscoveryTarget,
} from './copilot-profile-model-discovery';

function profile(overrides: Partial<CopilotAccountProfile> & { id: string }): CopilotAccountProfile {
  return {
    label: overrides.id,
    expectedLogin: null,
    host: 'github.com',
    accountKind: 'personal',
    scopePolicy: 'default-eligible',
    automationPolicy: 'allow-routed',
    isDefault: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as CopilotAccountProfile;
}

function model(id: string): CopilotModelInfo {
  return { id, name: id, supportsVision: true, contextWindow: 128_000, enabled: true };
}

const PERSONAL = profile({ id: 'legacy', isDefault: true, isLegacy: true });
const ENTERPRISE = profile({ id: 'enterprise', host: 'ebrd.ghe.com', scopePolicy: 'matched-only' });
const NO_SEAT = profile({ id: 'no-seat' });

describe('copilotDiscoveryTargets', () => {
  it('puts the default profile first and carries legacy flag and host', () => {
    expect(copilotDiscoveryTargets([ENTERPRISE, PERSONAL])).toEqual([
      { profileId: 'legacy', isLegacy: true, host: 'github.com' },
      { profileId: 'enterprise', isLegacy: false, host: 'ebrd.ghe.com' },
    ]);
  });

  it('falls back to the legacy home, never the ambient account, when no profiles exist', () => {
    expect(copilotDiscoveryTargets([])).toEqual([{ profileId: 'legacy', isLegacy: true }]);
  });
});

describe('listCopilotModelsAcrossProfiles', () => {
  it('unions every seat’s roster, default seat order first, deduped by id', async () => {
    const rosters: Record<string, string[]> = {
      legacy: ['claude-sonnet-5', 'gpt-6-luna'],
      enterprise: ['claude-sonnet-5', 'claude-opus-5.5', 'gpt-6-sol', 'GPT-6-LUNA'],
    };
    const models = await listCopilotModelsAcrossProfiles({
      listProfiles: () => [ENTERPRISE, PERSONAL],
      listForProfile: async (target) => (rosters[target.profileId] ?? []).map(model),
    });

    expect(models.map((entry) => entry.id)).toEqual([
      'claude-sonnet-5',
      'gpt-6-luna',
      'claude-opus-5.5',
      'gpt-6-sol',
    ]);
  });

  it('lists each profile through its own target', async () => {
    const seen: CopilotProfileDiscoveryTarget[] = [];
    await listCopilotModelsAcrossProfiles({
      listProfiles: () => [PERSONAL, ENTERPRISE],
      listForProfile: async (target) => {
        seen.push(target);
        return [model('auto')];
      },
    });
    expect(seen.map((target) => target.profileId)).toEqual(['legacy', 'enterprise']);
  });

  it('ignores a failing seat, including one that throws synchronously', async () => {
    const models = await listCopilotModelsAcrossProfiles({
      listProfiles: () => [PERSONAL, NO_SEAT, ENTERPRISE],
      listForProfile: (target) => {
        if (target.profileId === 'no-seat') {
          throw new Error('403 not authorized to use this Copilot feature');
        }
        return Promise.resolve([model(target.profileId === 'enterprise' ? 'claude-opus-5.5' : 'claude-sonnet-5')]);
      },
    });
    expect(models.map((entry) => entry.id)).toEqual(['claude-sonnet-5', 'claude-opus-5.5']);
  });

  it('rejects when no seat produced a roster, so the catalog keeps its last good state', async () => {
    await expect(listCopilotModelsAcrossProfiles({
      listProfiles: () => [PERSONAL, ENTERPRISE],
      listForProfile: async (target) => {
        throw new Error(`help config failed for ${target.profileId}`);
      },
    })).rejects.toThrow('help config failed for legacy');
  });
});
