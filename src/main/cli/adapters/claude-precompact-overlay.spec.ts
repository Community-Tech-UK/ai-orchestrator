import { describe, expect, it, vi } from 'vitest';
import { buildClaudeCliArgs, buildClaudeSettingsOverlay } from './claude-cli-argv-builder';
import { buildPreCompactOverlay } from './claude-precompact-overlay';

vi.mock('../hooks/hook-path-resolver', async importOriginal => ({
  ...await importOriginal<typeof import('../hooks/hook-path-resolver')>(),
  buildPreCompactRoleHookCommand: (role: string) => `node '/hooks/compact.mjs' ${role}`,
}));

describe('Claude compaction settings on the real launch path', () => {
  it.each([
    ['plan-queue', 'queue-worker'], ['loop', 'loop'], ['automation', 'automation'],
  ] as const)('keeps both permission and %s compaction hooks', (machineSession, role) => {
    const args = buildClaudeCliArgs({
      spawnOptions: { machineSession, permissionHookPath: '/hooks/defer.mjs' },
      sessionId: null, excludeDynamicSectionsSupported: null, cliVersion: '2.1.304',
      shouldUseNativeResume: false, shouldUsePermissionHook: true,
      disallowedToolsOverride: null, materializeInlineJsonArg: value => value,
    });
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
    expect(settings.precomputeCompactionEnabled).toBe(false);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('defer.mjs');
    expect(settings.hooks.PreCompact[0].hooks[0]).toEqual({
      type: 'command', command: `node '/hooks/compact.mjs' ${role}`, timeout: 5,
    });
  });

  it('does not add role guidance to ordinary helpers or chats', () => {
    expect(buildClaudeSettingsOverlay({}, false)).toBeUndefined();
    const child = JSON.parse(buildClaudeSettingsOverlay({ machineSession: 'child' }, false)!);
    expect(child.precomputeCompactionEnabled).toBe(false);
    expect(child.hooks).toBeUndefined();
  });

  it('still disables speculative compaction if the optional hook script is missing', () => {
    expect(buildPreCompactOverlay('loop', () => undefined)).toEqual({ precomputeCompactionEnabled: false });
  });
});
