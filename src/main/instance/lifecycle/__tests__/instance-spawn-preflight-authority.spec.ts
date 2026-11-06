import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_AGENTS } from '../../../../shared/types/agent.types';
import { createClaudeAdapter, type CliAdapter, type UnifiedSpawnOptions } from '../../../cli/adapters/adapter-factory';
import { buildWorkerArgs } from '../../../cli/spawn-worker/cli-adapter-worker-args';
import { InstanceSpawnPreflightChain } from '../instance-spawn-preflight-chain';
import { buildToolPermissionConfig } from '../tool-permission-config';
import { resolveSpawnReasoningEffort } from '../reasoning-effort-resolution';

describe('warm admission with production tool permissions', () => {
  it.each(['claude', 'codex', 'gemini', 'cursor'] as const)(
    'reuses the default %s adapter but spawns fresh for inherited Plan restrictions', async (provider) => {
      const adapter = { getName: () => provider } as CliAdapter;
      const consumeWarmAdapter = vi.fn(() => adapter);
      const assertLocalModelRuntimeAvailable = vi.fn().mockResolvedValue(undefined);
      const chain = new InstanceSpawnPreflightChain({
        consumeWarmAdapter,
        assertLocalModelRuntimeAvailable,
        warmCodememWorkspace: async () => undefined,
      });

      for (const agentId of ['build', 'plan']) {
        const agent = BUILTIN_AGENTS.find((candidate) => candidate.id === agentId)!;
        const permissions = buildToolPermissionConfig(agent.permissions, {
          allowedToolsPolicy: 'allow-all', yoloMode: false,
        });
        const spawnOptions = {
          workingDirectory: '/tmp/project',
          reasoningEffort: resolveSpawnReasoningEffort({}, provider),
          yoloMode: false,
          allowedTools: permissions.allowedTools,
          disallowedTools: permissions.disallowedToolsForSpawn,
        };
        const result = await chain.prepare({
          config: { workingDirectory: '/tmp/project', provider, agentId },
          instance: { workingDirectory: '/tmp/project' }, provider, spawnOptions,
        });

        if (agentId === 'build') {
          expect(result).toEqual({ kind: 'warm', adapter });
          expect(consumeWarmAdapter).toHaveBeenCalledExactlyOnceWith(provider, '/tmp/project');
          expect(assertLocalModelRuntimeAvailable).not.toHaveBeenCalled();
        } else {
          expect(result).toEqual({ kind: 'fresh', executionLocation: { type: 'local' }, spawnOptions });
          expect(consumeWarmAdapter).toHaveBeenCalledTimes(1);
          expect(spawnOptions.disallowedTools).toEqual(expect.arrayContaining(['Write', 'Edit', 'NotebookEdit']));
        }
      }
    },
  );
});

describe('warm admission to Claude process arguments', () => {
  it.each(['adapter', 'worker'] as const)('uses the same default denials for warm and cold %s launches', (route) => {
    const build = BUILTIN_AGENTS.find((agent) => agent.id === 'build')!;
    const permissions = buildToolPermissionConfig(build.permissions, { allowedToolsPolicy: 'allow-all' });
    const warm: UnifiedSpawnOptions = { workingDirectory: '/tmp/project', reasoningEffort: resolveSpawnReasoningEffort({}, 'claude') };
    const denials = (options: UnifiedSpawnOptions) => {
      let args: string[];
      if (route === 'worker') {
        args = buildWorkerArgs('claude', options, null, { role: 'user', content: 'test' });
      } else {
        const adapter = createClaudeAdapter(options) as unknown as {
          cachedCliStatus: { available: boolean; version: string };
          buildArgs(message: { role: 'user'; content: string }): string[];
        };
        adapter.cachedCliStatus = { available: true, version: '2.1.296' };
        args = adapter.buildArgs({ role: 'user', content: 'test' });
      }
      return args[args.indexOf('--disallowedTools') + 1].split(',');
    };
    const warmDenials = denials(warm);
    expect(warmDenials).toEqual(denials({ ...warm, disallowedTools: permissions.disallowedToolsForSpawn }));
    expect(warmDenials).toEqual(expect.arrayContaining(['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'CronCreate', 'RemoteTrigger']));
  });

  it.each([false, true])('carries the Plan agent denial through the real adapter factory with hook=%s', async (hook) => {
    const plan = BUILTIN_AGENTS.find((agent) => agent.id === 'plan')!;
    const permissions = buildToolPermissionConfig(plan.permissions, { allowedToolsPolicy: 'allow-all', yoloMode: false });
    const consumeWarmAdapter = vi.fn(() => ({ getName: () => 'claude' }) as CliAdapter);
    const result = await new InstanceSpawnPreflightChain({
      consumeWarmAdapter,
      assertLocalModelRuntimeAvailable: async () => undefined,
      warmCodememWorkspace: async () => undefined,
    }).prepare({
      config: { workingDirectory: '/tmp/project', provider: 'claude', agentId: 'plan' },
      instance: { workingDirectory: '/tmp/project' }, provider: 'claude',
      spawnOptions: {
        workingDirectory: '/tmp/project', reasoningEffort: 'high', yoloMode: false,
        allowedTools: permissions.allowedTools,
        disallowedTools: permissions.disallowedToolsForSpawn,
        ...(hook ? { permissionHookPath: '/tmp/permission-hook.mjs' } : {}),
      },
    });
    expect(result.kind).toBe('fresh');
    expect(consumeWarmAdapter).not.toHaveBeenCalled();
    if (result.kind !== 'fresh') throw new Error('Restricted runtime adopted the warm process');

    const adapter = createClaudeAdapter(result.spawnOptions);
    // The real adapter gates hooks on its detected CLI version. No CLI process
    // or account is needed to exercise its production argv construction.
    const launch = adapter as unknown as {
      cachedCliStatus: { available: boolean; version: string };
      buildArgs(message: { role: 'user'; content: string }): string[];
    };
    launch.cachedCliStatus = { available: true, version: '2.1.296' };
    const args = launch.buildArgs({ role: 'user', content: 'Write blocked.txt' });
    const denials = args[args.indexOf('--disallowedTools') + 1].split(',');
    expect(denials).toEqual(expect.arrayContaining(['Write', 'Edit', 'NotebookEdit']));
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
    expect(args).not.toContain('--dangerously-skip-permissions');
    if (hook) {
      const overlay = JSON.parse(args[args.indexOf('--settings') + 1]);
      expect(overlay.hooks.PreToolUse[0]).toMatchObject({
        matcher: 'Bash', hooks: [{ type: 'command', command: expect.stringContaining('/tmp/permission-hook.mjs') }],
      });
    }
  });
});
