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

  it('caps Claude-only tiers at xhigh for Codex', () => {
    expect(mapReasoningEffortForProvider('codex', 'max')).toBe('xhigh');
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
