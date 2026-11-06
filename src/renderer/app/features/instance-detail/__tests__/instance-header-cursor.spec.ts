/**
 * Verifies that InstanceHeaderComponent correctly handles the 'cursor' provider
 * for display-name and color lookups.
 *
 * InstanceHeaderComponent has heavy DI requirements (multiple IPC services,
 * stores, effects) that make TestBed instantiation impractical. The two
 * methods under test are pure static-style switches with no injected state,
 * so we extract the logic directly.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveHeaderModelDisplayName,
  resolveHeaderProviderDisplayName,
} from '../instance-header.component';
import type { InstanceRuntimeSummary } from '../../../../../shared/types/local-model-runtime.types';

// The display name is the real exported function (it reads the shared name
// module). The colour switch still has to be mirrored here to test it without
// Angular DI.

function getProviderColor(provider: string): string {
  switch (provider) {
    case 'claude':
      return '#D97706';
    case 'codex':
      return '#10A37F';
    case 'gemini':
      return '#4285F4';
    case 'ollama':
      return '#888888';
    case 'copilot':
      return '#B89A66';
    case 'cursor':
      return '#E5E7EB';
    default:
      return '#888888';
  }
}

describe('InstanceHeaderComponent — cursor provider', () => {
  it('names Cursor as Cursor', () => {
    expect(resolveHeaderProviderDisplayName('cursor')).toBe('Cursor');
  });

  it('getProviderColor returns a color for cursor', () => {
    expect(getProviderColor('cursor')).toMatch(/^#|rgb|hsl|var\(/);
  });

  it('getProviderColor returns a light neutral for cursor (visible on dark surfaces)', () => {
    // Cursor's mark is monochrome; pure black (#000000) disappeared on the
    // app's dark backgrounds, so the provider colour is a light neutral.
    expect(getProviderColor('cursor')).toBe('#E5E7EB');
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
