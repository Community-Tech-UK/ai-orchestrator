import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliAdapter } from '../adapter-factory';
import {
  _resetHardenedModeScopingForTesting,
  setInstanceHardened,
} from '../../../instance/lifecycle/hardened-mode-scoping';

describe('adapter factory — hardened remote execution', () => {
  beforeEach(() => _resetHardenedModeScopingForTesting());
  afterEach(() => _resetHardenedModeScopingForTesting());

  it('fails closed before constructing a remote adapter for a hardened instance', () => {
    setInstanceHardened('hardened-remote', true);

    expect(() => createCliAdapter(
      'claude',
      {
        instanceId: 'hardened-remote',
        workingDirectory: '/tmp',
      },
      {
        type: 'remote',
        nodeId: 'worker-node',
      },
    )).toThrow('Hardened mode is not supported for remote instances');
  });

  it('refuses a hardened local Codex session up front (LT-028)', () => {
    setInstanceHardened('hardened-codex', true);

    expect(() => createCliAdapter('codex', {
      instanceId: 'hardened-codex',
      workingDirectory: '/tmp',
    })).toThrow('Hardened mode is not supported for Codex');
  });

  it.each([
    ['grok', 'Grok'],
    ['cursor', 'Cursor'],
    ['opencode', 'OpenCode'],
    ['copilot', 'Copilot'],
    ['antigravity', 'Antigravity'],
  ] as const)('refuses a hardened %s session that has no jail evidence', (cliType, name) => {
    setInstanceHardened(`hardened-${cliType}`, true);

    expect(() => createCliAdapter(cliType, {
      instanceId: `hardened-${cliType}`,
      workingDirectory: '/tmp',
    })).toThrow(`Hardened mode is not supported for ${name} yet`);
  });

  it('still builds a hardened local Claude adapter', () => {
    setInstanceHardened('hardened-claude', true);

    const adapter = createCliAdapter('claude', {
      instanceId: 'hardened-claude',
      workingDirectory: '/tmp',
    }) as unknown as { hardenedMode: { writableRoots: string[] } | null };

    expect(adapter.hardenedMode?.writableRoots).toContain('/tmp');
  });

  it('keeps hardened mode a no-op for the tool-free Ollama adapter', () => {
    setInstanceHardened('hardened-ollama', true);

    const adapter = createCliAdapter('ollama', {
      instanceId: 'hardened-ollama',
      workingDirectory: '/tmp',
    }) as unknown as { hardenedMode: { writableRoots: string[] } | null };

    expect(adapter.hardenedMode).toBeNull();
  });

  it('still builds a non-hardened local Codex adapter', () => {
    expect(() => createCliAdapter('codex', {
      instanceId: 'plain-codex',
      workingDirectory: '/tmp',
    })).not.toThrow();
  });
});
