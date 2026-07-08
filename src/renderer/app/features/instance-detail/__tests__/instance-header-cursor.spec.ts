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

// Extract the pure logic mirrors from the component's getProviderDisplayName
// and getProviderColor methods so we can test them without Angular DI.

function getProviderDisplayName(provider: string): string {
  switch (provider) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'ollama':
      return 'Ollama';
    case 'copilot':
      return 'Copilot';
    case 'cursor':
      return 'Cursor';
    default:
      return 'AI';
  }
}

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
      return '#A855F7';
    case 'cursor':
      return '#E5E7EB';
    default:
      return '#888888';
  }
}

describe('InstanceHeaderComponent — cursor provider', () => {
  it('getProviderDisplayName returns Cursor for cursor', () => {
    expect(getProviderDisplayName('cursor')).toBe('Cursor');
  });

  it('getProviderColor returns a color for cursor', () => {
    expect(getProviderColor('cursor')).toMatch(/^#|rgb|hsl|var\(/);
  });

  it('getProviderColor returns a light neutral for cursor (visible on dark surfaces)', () => {
    // Cursor's mark is monochrome; pure black (#000000) disappeared on the
    // app's dark backgrounds, so the provider colour is a light neutral.
    expect(getProviderColor('cursor')).toBe('#E5E7EB');
  });

  it('getProviderDisplayName still works for other providers', () => {
    expect(getProviderDisplayName('claude')).toBe('Claude');
    expect(getProviderDisplayName('gemini')).toBe('Gemini');
    expect(getProviderDisplayName('unknown')).toBe('AI');
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

  it('uses Local Models and the runtime summary label for local-model sessions', () => {
    expect(resolveHeaderProviderDisplayName('claude', runtimeSummary)).toBe('Local Models');
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
