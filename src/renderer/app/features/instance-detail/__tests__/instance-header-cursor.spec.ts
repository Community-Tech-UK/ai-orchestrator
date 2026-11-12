/** Provider and local-model naming used by the session header and composer, tested as pure functions. */
import { describe, it, expect } from 'vitest';
import {
  resolveHeaderModelDisplayName,
  resolveHeaderProviderDisplayName,
} from '../instance-header-presentation';
import type { InstanceRuntimeSummary } from '../../../../../shared/types/local-model-runtime.types';

describe('InstanceHeaderComponent — cursor provider', () => {
  it('names Cursor as Cursor', () => {
    expect(resolveHeaderProviderDisplayName('cursor')).toBe('Cursor');
  });

  it('names the other providers with the one shared name', () => {
    expect(resolveHeaderProviderDisplayName('claude')).toBe('Claude');
    expect(resolveHeaderProviderDisplayName('gemini')).toBe('Gemini');
    expect(resolveHeaderProviderDisplayName('codex')).toBe('Codex');
  });

  it('names OpenCode "OpenCode" unless the session\'s model is a MiMo plan model', () => {
    expect(resolveHeaderProviderDisplayName('opencode')).toBe('OpenCode');
    expect(resolveHeaderProviderDisplayName('opencode', undefined, 'opencode/big-pickle')).toBe('OpenCode');
    expect(resolveHeaderProviderDisplayName('opencode', undefined, 'openrouter/anthropic/claude-sonnet-4')).toBe('OpenCode');
    expect(resolveHeaderProviderDisplayName('opencode', undefined, 'xiaomi-token-plan-ams/mimo-v2.5-pro')).toBe('MiMo');
    expect(resolveHeaderProviderDisplayName('opencode', undefined, 'aio-mimo-work/mimo-v2.5-pro')).toBe('MiMo');
  });

  it('ignores the model for every provider except OpenCode', () => {
    expect(resolveHeaderProviderDisplayName('claude', undefined, 'xiaomi-token-plan-ams/mimo-v2.5-pro')).toBe('Claude');
  });

  it('shows an unknown provider in plain words rather than a bare "AI"', () => {
    expect(resolveHeaderProviderDisplayName('some-new-tool')).toBe('Some new tool');
  });
});

describe('InstanceHeaderComponent — local model runtime display', () => {
  const runtimeSummary: InstanceRuntimeSummary = {
    kind: 'local-model',
    label: 'qwen on windows-pc',
    nodeId: 'node-win',
    nodeName: 'windows-pc',
    endpointProvider: 'ollama',
    modelId: 'qwen',
  };

  it('uses Local models and the runtime summary label for local-model sessions', () => {
    expect(resolveHeaderProviderDisplayName('claude', runtimeSummary)).toBe('Local models');
    expect(
      resolveHeaderModelDisplayName({
        runtimeSummary,
        currentModel: 'opus',
        availableModels: [],
        provider: 'claude',
      }),
    ).toBe('qwen on windows-pc');
  });
});
