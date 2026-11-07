import { describe, expect, it, vi } from 'vitest';
import { buildClaudeCliArgs } from './claude-cli-argv-builder';
import type { ClaudeCliSpawnOptions } from './claude-cli-adapter.types';
const { received } = vi.hoisted(() => ({ received: vi.fn() }));
vi.mock('./claude-cli-adapter', () => ({ ClaudeCliAdapter: class { constructor(options: unknown) { received(options); } } }));
vi.mock('./account-pool/account-adapter-guards', () => ({ resolveClaudeAccountSpawnEnv: () => ({ env: {}, envRemove: [] }) }));
import { createClaudeAdapter } from './adapter-factory';

describe('live permission spawn transport', () => {
  function args(spawnOptions: ClaudeCliSpawnOptions = {}, enabled?: boolean, supported = true) {
    return buildClaudeCliArgs({ spawnOptions, sessionId: null, excludeDynamicSectionsSupported: false, cliVersion: '2.1.300', disallowedToolsOverride: null,
      shouldUseNativeResume: false, shouldUsePermissionHook: supported, livePermissionPrompts: enabled, materializeInlineJsonArg: value => value });
  }
  it('passes instance identity and explicit opt-in to the Claude adapter', () => {
    createClaudeAdapter({ instanceId: 'instance-placeholder', livePermissionPrompts: true });
    expect(received).toHaveBeenLastCalledWith(expect.objectContaining({ instanceId: 'instance-placeholder', livePermissionPrompts: true }));
  });
  it('enables stdio only for supported resident interactive ask-first sessions', () => {
    expect(args({ residentClaude: true }, true)).toContain('--permission-prompt-tool');
    expect(args({ residentClaude: true }, true)).toContain('stdio');
    for (const opts of [{}, { residentClaude: false }, { residentClaude: true, yoloMode: true }, { residentClaude: true, readOnlyReview: true }, { residentClaude: true, machineSession: 'loop' as const }]) {
      expect(args(opts, true)).not.toContain('--permission-prompt-tool');
    }
    expect(args({ residentClaude: true })).not.toContain('--permission-prompt-tool');
    expect(args({ residentClaude: true }, true, false)).not.toContain('--permission-prompt-tool');
  });
});
