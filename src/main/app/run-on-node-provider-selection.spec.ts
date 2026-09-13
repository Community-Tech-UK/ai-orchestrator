import { describe, expect, it, vi } from 'vitest';
import type { CanonicalCliType } from '../../shared/types/settings.types';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';

vi.mock('../providers/automation-provider-exclusions', () => ({
  filterProvidersForAutomation: <T extends string>(providers: readonly T[]) => [...providers],
}));

import { resolveRunOnNodeProvider } from './run-on-node-support';

type ConcreteProvider = Exclude<CanonicalCliType, 'auto'>;

const WINDOWS_NODE: WorkerNodeInfo = {
  id: 'windows-pc-id',
  name: 'windows-pc',
  status: 'connected',
  activeInstances: 0,
  capabilities: {
    platform: 'win32',
    arch: 'x64',
    cpuCores: 8,
    totalMemoryMB: 16_384,
    availableMemoryMB: 8_192,
    supportedClis: ['antigravity', 'copilot', 'cursor'],
    hasBrowserRuntime: true,
    hasBrowserMcp: true,
    hasAndroidMcp: false,
    hasDocker: false,
    maxConcurrentInstances: 4,
    workingDirectories: ['C:\\work'],
    browsableRoots: ['C:\\work'],
    discoveredProjects: [],
  },
};

function diagnostic(
  provider: ConcreteProvider,
  authenticated: boolean | null,
): unknown {
  return {
    ok: authenticated === true,
    platform: 'win32',
    identity: {
      username: 'worker-user',
      homeDir: 'C:\\Users\\worker-user',
      serviceAccountLikely: false,
    },
    provider: {
      provider,
      available: true,
      authenticated,
    },
  };
}

describe('resolveRunOnNodeProvider worker-auth admission', () => {
  it('selects authenticated Antigravity from the incident node topology when configured Claude is absent', async () => {
    const diagnose = vi.fn(async (provider: ConcreteProvider) => {
      return diagnostic(provider, provider === 'antigravity');
    });

    await expect(resolveRunOnNodeProvider(
      WINDOWS_NODE,
      undefined,
      'claude',
      diagnose,
    )).resolves.toBe('antigravity');
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(diagnose).toHaveBeenCalledWith('antigravity');
  });

  it.each([
    ['null authentication', diagnostic('antigravity', null)],
    ['explicit false authentication', diagnostic('antigravity', false)],
    ['malformed string authentication', {
      ...diagnostic('antigravity', true) as Record<string, unknown>,
      provider: {
        provider: 'antigravity',
        available: true,
        authenticated: 'true',
      },
    }],
  ])('does not admit Antigravity from %s and falls back to proven Copilot', async (_name, antigravity) => {
    const diagnose = vi.fn(async (provider: ConcreteProvider) => {
      return provider === 'antigravity' ? antigravity : diagnostic(provider, provider === 'copilot');
    });

    await expect(resolveRunOnNodeProvider(
      WINDOWS_NODE,
      undefined,
      'claude',
      diagnose,
    )).resolves.toBe('copilot');
    expect(diagnose.mock.calls.map(([provider]) => provider)).toEqual(['antigravity', 'copilot']);
  });

  it('fails closed when no advertised provider returns structurally valid authenticated evidence', async () => {
    const diagnose = vi.fn(async (provider: ConcreteProvider) => {
      if (provider === 'antigravity') return diagnostic(provider, null);
      if (provider === 'copilot') return diagnostic(provider, false);
      return {
        ok: true,
        provider: { provider, available: true, authenticated: 'yes' },
      };
    });

    await expect(resolveRunOnNodeProvider(
      WINDOWS_NODE,
      undefined,
      'claude',
      diagnose,
    )).rejects.toThrow(/cli_not_signed_in.*windows-pc/i);
    expect(diagnose.mock.calls.map(([provider]) => provider)).toEqual([
      'antigravity',
      'copilot',
      'cursor',
    ]);
  });

  it('does not fall back when explicitly requested Antigravity lacks positive auth evidence', async () => {
    const diagnose = vi.fn(async () => diagnostic('antigravity', null));

    await expect(resolveRunOnNodeProvider(
      WINDOWS_NODE,
      'antigravity',
      'claude',
      diagnose,
    )).rejects.toThrow(/cli_not_signed_in.*antigravity/i);
    expect(diagnose).toHaveBeenCalledTimes(1);
  });
});
