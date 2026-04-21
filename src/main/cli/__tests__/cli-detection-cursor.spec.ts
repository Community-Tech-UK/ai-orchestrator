import { describe, it, expect } from 'vitest';
import { SUPPORTED_CLIS, CLI_REGISTRY } from '../cli-detection';

describe('CLI registry — cursor', () => {
  it('SUPPORTED_CLIS includes cursor', () => {
    expect(SUPPORTED_CLIS).toContain('cursor');
  });

  it('CLI_REGISTRY.cursor has expected command metadata', () => {
    expect(CLI_REGISTRY.cursor).toMatchObject({
      name: 'cursor',
      command: 'cursor-agent',
      displayName: 'Cursor CLI',
    });
    expect(CLI_REGISTRY.cursor.versionFlag).toBe('--version');
    expect(CLI_REGISTRY.cursor.versionPattern).toBeInstanceOf(RegExp);
    expect(Array.isArray(CLI_REGISTRY.cursor.capabilities)).toBe(true);
    expect(Array.isArray(CLI_REGISTRY.cursor.alternativePaths)).toBe(true);
    expect(CLI_REGISTRY.cursor.alternativePaths.length).toBeGreaterThan(0);
  });
});
