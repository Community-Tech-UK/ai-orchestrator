import { describe, expect, it } from 'vitest';
import type { CliMessage } from '../adapters/base-cli-adapter';
import type { UnifiedSpawnOptions } from '../adapters/adapter-factory';
import { buildWorkerArgs } from './cli-adapter-worker-args';

const message: CliMessage = { role: 'user', content: 'hi' };

describe('worker overlay goes through the shared output-cap helper (A19, Step 9a)', () => {
  it('omits bashOutputMaxChars without a CLI version (this path never learns one)', () => {
    const args = buildWorkerArgs('claude', { bashOutputMaxChars: 12_000 } as UnifiedSpawnOptions, null, message);
    const overlayIndex = args.indexOf('--settings');
    if (overlayIndex === -1) {
      expect(args.join(' ')).not.toContain('bashOutputMaxChars');
      return;
    }
    const overlay = JSON.parse(args[overlayIndex + 1]) as Record<string, unknown>;
    expect(overlay['bashOutputMaxChars']).toBeUndefined();
  });

  it('builds no overlay at all for a plain auto-approve spawn', () => {
    const args = buildWorkerArgs('claude', { yoloMode: true, bashOutputMaxChars: 12_000 } as UnifiedSpawnOptions, null, message);
    expect(args).not.toContain('--settings');
  });
});

import { buildClaudeCliArgs } from '../adapters/claude-cli-argv-builder';

describe('worker Claude turn caps', () => {
  it.each([1, 8, 50])('forwards the positive integer cap %s', maxTurns => {
    const args = buildWorkerArgs('claude', { maxTurns, maxBudgetUsd: 1 }, 'fixture', { role: 'user', content: 'review' });
    expect(args.slice(args.indexOf('--max-turns'), args.indexOf('--max-turns') + 2)).toEqual(['--max-turns', String(maxTurns)]);
    expect(args.slice(args.indexOf('--max-budget-usd'), args.indexOf('--max-budget-usd') + 2)).toEqual(['--max-budget-usd', '1']);
  });

  it.each([undefined, 0, -1, 0.5, NaN, Infinity, -Infinity])('omits invalid or absent cap %s', maxTurns => {
    const args = buildWorkerArgs('claude', { maxTurns }, 'fixture', { role: 'user', content: 'review' });
    expect(args).not.toContain('--max-turns');
  });

  it('retains a turn cap on resume while omitting the fresh-session budget', () => {
    const args = buildWorkerArgs('claude', { resume: true, maxTurns: 8, maxBudgetUsd: 1 }, 'fixture', { role: 'user', content: 'review' });
    expect(args.slice(args.indexOf('--max-turns'), args.indexOf('--max-turns') + 2)).toEqual(['--max-turns', '8']);
    expect(args).toContain('--resume');
    expect(args).not.toContain('--max-budget-usd');
  });

  it('keeps Gemini free of unsupported Claude caps', () => {
    const args = buildWorkerArgs('gemini', { maxTurns: 8, maxBudgetUsd: 1 }, null, { role: 'user', content: 'review' });
    expect(args).not.toContain('--max-turns');
    expect(args).not.toContain('--max-budget-usd');
  });

  it('matches the existing direct Claude eight-turn and fresh-budget behavior', () => {
    const options = { maxTurns: 8, maxBudgetUsd: 1 };
    const direct = buildClaudeCliArgs({ spawnOptions: options, sessionId: null,
      excludeDynamicSectionsSupported: null, cliVersion: null, disallowedToolsOverride: null,
      shouldUseNativeResume: false, shouldUsePermissionHook: false, materializeInlineJsonArg: value => value });
    const worker = buildWorkerArgs('claude', options, null, { role: 'user', content: 'review' });
    for (const flag of ['--max-turns', '--max-budget-usd']) {
      expect(worker.slice(worker.indexOf(flag), worker.indexOf(flag) + 2))
        .toEqual(direct.slice(direct.indexOf(flag), direct.indexOf(flag) + 2));
    }
  });
});

describe('isolated Claude worker command output cap', () => {
  it('omits the cap because this path has no executing CLI version', () => {
    const args = buildWorkerArgs('claude', { bashOutputMaxChars: 12_000, reasoningEffort: 'workflow' }, null, { role: 'user', content: 'hello' });
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ ultracode: true });
  });
});

describe('worker Claude Bash PreToolUse hook (Step 18b item 3)', () => {
  const RTK_HOOK = '/placeholder/hooks/rtk-defer-hook.mjs';
  const DEFER_HOOK = '/placeholder/hooks/defer-permission-hook.mjs';
  const rtk = (yoloHookPath?: string): NonNullable<UnifiedSpawnOptions['rtk']> =>
    ({ enabled: true, binaryPath: '/placeholder/rtk', ...(yoloHookPath ? { yoloHookPath } : {}) });

  type Hooks = { matcher: string; hooks: { type: string; command: string }[] }[];
  function hooksOf(args: string[]): Hooks | undefined {
    const index = args.indexOf('--settings');
    return index === -1 ? undefined : (JSON.parse(args[index + 1]) as { hooks?: { PreToolUse: Hooks } }).hooks?.PreToolUse;
  }
  const direct = (spawnOptions: UnifiedSpawnOptions): string[] => buildClaudeCliArgs({
    spawnOptions, sessionId: null, excludeDynamicSectionsSupported: null, cliVersion: null,
    disallowedToolsOverride: null, shouldUseNativeResume: false,
    shouldUsePermissionHook: Boolean(spawnOptions.permissionHookPath),
    materializeInlineJsonArg: value => value,
  });

  it('auto-approve with rtk.yoloHookPath produces exactly one Bash PreToolUse hook running the rewrite-only script', () => {
    const args = buildWorkerArgs('claude',
      { yoloMode: true, permissionHookPath: DEFER_HOOK, rtk: rtk(RTK_HOOK) }, null, message);
    expect(args.filter(arg => arg === '--settings')).toHaveLength(1);
    const hooks = hooksOf(args);
    expect(hooks).toHaveLength(1);
    expect(hooks![0].matcher).toBe('Bash');
    expect(hooks![0].hooks).toHaveLength(1);
    expect(hooks![0].hooks[0].command).toMatch(/^node /);
    expect(hooks![0].hooks[0].command).toContain(RTK_HOOK);
    expect(hooks![0].hooks[0].command).not.toContain(DEFER_HOOK);
  });

  it.each([
    ['rtk without a yoloHookPath', rtk()],
    ['no rtk config', undefined],
    ['rtk disabled', { enabled: false, binaryPath: '/placeholder/rtk', yoloHookPath: RTK_HOOK }],
  ])('auto-approve with %s produces no hooks', (_label, rtkConfig) => {
    const args = buildWorkerArgs('claude',
      { yoloMode: true, permissionHookPath: DEFER_HOOK, ...(rtkConfig ? { rtk: rtkConfig } : {}) }, null, message);
    expect(hooksOf(args)).toBeUndefined();
    expect(args.join(' ')).not.toContain(RTK_HOOK);
    expect(args.join(' ')).not.toContain(DEFER_HOOK);
  });

  it('non-auto-approve still gets the defer hook, not the rewrite-only script', () => {
    const args = buildWorkerArgs('claude',
      { yoloMode: false, permissionHookPath: DEFER_HOOK, rtk: rtk(RTK_HOOK) }, null, message);
    const hooks = hooksOf(args);
    // Bash plus Harness's own tools that are held for approval.
    expect(hooks).toHaveLength(2);
    for (const entry of hooks!) {
      expect(entry.hooks[0].command).toContain(DEFER_HOOK);
      expect(entry.hooks[0].command).not.toContain(RTK_HOOK);
    }
  });

  it.each([
    ['auto-approve with the rewrite-only script', { yoloMode: true, permissionHookPath: DEFER_HOOK, rtk: rtk(RTK_HOOK) }],
    ['auto-approve without it', { yoloMode: true, permissionHookPath: DEFER_HOOK, rtk: rtk() }],
    ['non-auto-approve', { yoloMode: false, permissionHookPath: DEFER_HOOK, rtk: rtk(RTK_HOOK) }],
    ['a non-auto-approve scheduled session', { yoloMode: false, machineSession: 'automation', permissionHookPath: DEFER_HOOK, rtk: rtk(RTK_HOOK) }],
  ] as const)('both overlay builders agree on the hook for %s', (_label, options) => {
    const allHooks = (args: string[]) => {
      const index = args.indexOf('--settings');
      const hooks = index === -1 ? undefined : (JSON.parse(args[index + 1]) as { hooks?: Record<string, unknown> }).hooks;
      return { PreToolUse: hooks?.['PreToolUse'], PermissionRequest: hooks?.['PermissionRequest'] };
    };
    expect(hooksOf(buildWorkerArgs('claude', options, null, message))).toEqual(hooksOf(direct(options)));
    expect(allHooks(buildWorkerArgs('claude', options, null, message))).toEqual(allHooks(direct(options)));
  });
});
