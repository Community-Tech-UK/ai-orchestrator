import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockResolveCliType, mockGetNode } = vi.hoisted(() => ({
  mockResolveCliType: vi.fn(),
  mockGetNode: vi.fn(),
}));

vi.mock('../../cli/adapters/adapter-factory', () => ({
  resolveCliType: mockResolveCliType,
  getCliDisplayName: vi.fn((cli: string) => cli === 'codex' ? 'OpenAI Codex' : cli),
}));

vi.mock('../../remote-node/worker-node-registry', () => ({
  getWorkerNodeRegistry: vi.fn(() => ({ getNode: mockGetNode })),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

import {
  assertSwapTargetCliAvailable,
  mapReasoningEffortForProvider,
  resolveSwapModel,
  resolveSwapModelWithSource,
} from './model-change-provider-swap';
import type { Instance } from '../../../shared/types/instance.types';

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst-1',
    provider: 'claude',
    executionLocation: { type: 'local' },
    ...overrides,
  } as unknown as Instance;
}

describe('mapReasoningEffortForProvider', () => {
  it('passes efforts the target supports through unchanged', () => {
    expect(mapReasoningEffortForProvider('claude', 'high')).toBe('high');
    expect(mapReasoningEffortForProvider('codex', 'minimal')).toBe('minimal');
  });

  it('preserves "no override" (undefined)', () => {
    expect(mapReasoningEffortForProvider('codex', undefined)).toBeUndefined();
  });

  it('preserves Codex max and ultra and caps Claude workflow at xhigh', () => {
    expect(mapReasoningEffortForProvider('codex', 'max')).toBe('max');
    expect(mapReasoningEffortForProvider('codex', 'ultra')).toBe('ultra');
    expect(mapReasoningEffortForProvider('codex', 'workflow')).toBe('xhigh');
  });

  it('drops efforts Claude has no equivalent for', () => {
    expect(mapReasoningEffortForProvider('claude', 'none')).toBeUndefined();
    expect(mapReasoningEffortForProvider('claude', 'minimal')).toBeUndefined();
  });

  it('drops the effort entirely for providers without reasoning support', () => {
    expect(mapReasoningEffortForProvider('gemini', 'high')).toBeUndefined();
    expect(mapReasoningEffortForProvider('copilot', 'medium')).toBeUndefined();
  });
});

describe('resolveSwapModel', () => {
  const settings = {
    defaultModelByProvider: { codex: 'gpt-5.5' },
    defaultModel: 'opus',
  };

  it('prefers an explicitly requested model', () => {
    expect(resolveSwapModel('codex', 'gpt-5.3-codex', settings)).toBe('gpt-5.3-codex');
  });

  it('falls back to the remembered per-provider default', () => {
    expect(resolveSwapModel('codex', undefined, settings)).toBe('gpt-5.5');
    expect(resolveSwapModel('codex', '  ', settings)).toBe('gpt-5.5');
  });

  it('falls back to the global default when nothing is remembered', () => {
    expect(resolveSwapModel('gemini', undefined, settings)).toBe('opus');
  });

  it('returns undefined (provider default) when no source supplies a model', () => {
    expect(resolveSwapModel('gemini', undefined, { defaultModelByProvider: {}, defaultModel: '' })).toBeUndefined();
  });
});

// LT-016: an unpinned swap told the user their model was "no longer available"
// when the id came from the provider-agnostic global default they never chose
// for that provider. The notice is suppressed by provenance, so provenance has
// to be reported accurately.
describe('resolveSwapModelWithSource (LT-016 provenance)', () => {
  const settings = {
    defaultModelByProvider: { codex: 'gpt-5.5' },
    defaultModel: 'opus[1m]',
  };

  it('reports an explicitly requested model as "requested"', () => {
    expect(resolveSwapModelWithSource('codex', 'gpt-5.3-codex', settings)).toEqual({
      model: 'gpt-5.3-codex',
      source: 'requested',
    });
  });

  it('reports a remembered per-provider default as "remembered"', () => {
    expect(resolveSwapModelWithSource('codex', undefined, settings)).toEqual({
      model: 'gpt-5.5',
      source: 'remembered',
    });
    expect(resolveSwapModelWithSource('codex', '   ', settings)).toEqual({
      model: 'gpt-5.5',
      source: 'remembered',
    });
  });

  it('reports the global fallback as "global-default" — the case that must stay silent', () => {
    // `gemini` has nothing remembered, so this falls through to the global
    // default, which is a Claude model id. Its later rejection by the target
    // provider is not a degraded user selection.
    expect(resolveSwapModelWithSource('gemini', undefined, settings)).toEqual({
      model: 'opus[1m]',
      source: 'global-default',
    });
  });

  it('reports "provider-default" when no rung supplies a model', () => {
    expect(
      resolveSwapModelWithSource('gemini', undefined, { defaultModelByProvider: {}, defaultModel: '' }),
    ).toEqual({ model: undefined, source: 'provider-default' });
  });

  it('keeps resolveSwapModel behaviour identical to before', () => {
    for (const requested of [undefined, '  ', 'gpt-5.3-codex']) {
      expect(resolveSwapModel('codex', requested, settings)).toBe(
        resolveSwapModelWithSource('codex', requested, settings).model,
      );
    }
  });
});

describe('assertSwapTargetCliAvailable', () => {
  beforeEach(() => {
    mockResolveCliType.mockReset();
    mockGetNode.mockReset();
  });

  it('resolves when the local CLI detection confirms the target', async () => {
    mockResolveCliType.mockResolvedValue('codex');
    await expect(
      assertSwapTargetCliAvailable(makeInstance(), 'codex', 'auto'),
    ).resolves.toBeUndefined();
    expect(mockResolveCliType).toHaveBeenCalledWith('codex', 'auto');
  });

  it('throws loudly when local detection silently falls back to another CLI', async () => {
    mockResolveCliType.mockResolvedValue('claude'); // codex missing → fallback
    await expect(
      assertSwapTargetCliAvailable(makeInstance(), 'codex', 'auto'),
    ).rejects.toThrow('OpenAI Codex CLI is not installed');
  });

  it('checks the worker node capabilities for remote instances', async () => {
    mockGetNode.mockReturnValue({
      name: 'windows-pc',
      capabilities: { supportedClis: ['claude', 'codex'] },
    });
    await expect(
      assertSwapTargetCliAvailable(
        makeInstance({ executionLocation: { type: 'remote', nodeId: 'node-1' } }),
        'codex',
        'auto',
      ),
    ).resolves.toBeUndefined();
    expect(mockResolveCliType).not.toHaveBeenCalled();
  });

  it('rejects remote swaps when the node does not advertise the target CLI', async () => {
    mockGetNode.mockReturnValue({
      name: 'windows-pc',
      capabilities: { supportedClis: ['claude'] },
    });
    await expect(
      assertSwapTargetCliAvailable(
        makeInstance({ executionLocation: { type: 'remote', nodeId: 'node-1' } }),
        'codex',
        'auto',
      ),
    ).rejects.toThrow('does not have the OpenAI Codex CLI available');
  });

  it('rejects remote swaps when the node is no longer registered', async () => {
    mockGetNode.mockReturnValue(undefined);
    await expect(
      assertSwapTargetCliAvailable(
        makeInstance({ executionLocation: { type: 'remote', nodeId: 'node-gone' } }),
        'codex',
        'auto',
      ),
    ).rejects.toThrow('no longer registered');
  });
});
