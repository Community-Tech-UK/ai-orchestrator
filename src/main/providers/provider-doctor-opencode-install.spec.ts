import { describe, expect, it } from 'vitest';
import { buildRepairActions } from './provider-doctor-repair';

describe('OpenCode install offer', () => {
  it('offers v2 explicitly, preserves a pinned v1 fallback and explains command replacement', () => {
    const [action] = buildRepairActions({ provider: 'opencode', probes: [{ name: 'cli_installed', status: 'fail', message: 'missing' }] });
    expect(action.command).toContain('npm install -g @opencode/cli@2');
    expect(action.command).toContain('opencode-ai@1');
    expect(action.description).toContain('replaces');
    expect(action.description).toContain('OpenCode 1');
  });
});
