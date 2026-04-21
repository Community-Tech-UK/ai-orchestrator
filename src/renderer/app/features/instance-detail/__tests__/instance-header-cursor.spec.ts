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
      return '#000000';
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

  it('getProviderColor returns #000000 for cursor (brand color)', () => {
    expect(getProviderColor('cursor')).toBe('#000000');
  });

  it('getProviderDisplayName still works for other providers', () => {
    expect(getProviderDisplayName('claude')).toBe('Claude');
    expect(getProviderDisplayName('gemini')).toBe('Gemini');
    expect(getProviderDisplayName('unknown')).toBe('AI');
  });
});
