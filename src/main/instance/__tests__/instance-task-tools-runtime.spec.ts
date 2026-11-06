import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceLifecycleManager } from '../instance-lifecycle';
import { InstanceManager } from '../instance-manager';
import {
  _resetTaskToolsScopingForTesting, isInstanceTaskTools, setInstanceTaskTools,
} from '../lifecycle/task-tools-scoping';
import type { ExecutionLocation } from '../../../shared/types/worker-node.types';
import type { ProviderRuntimeStartInput } from '../../providers/provider-runtime-service';
import { createCliAdapter } from '../../cli/adapters/adapter-factory';
import { ClaudeCliAdapter } from '../../cli/adapters/claude-cli-adapter';

const runtimeAdapter = vi.hoisted(() => vi.fn<(input: ProviderRuntimeStartInput) => unknown>(() => ({})));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp/harness-task-test' } }));
vi.mock('electron-store', () => ({ default: class { store = {}; get(): unknown { return undefined; } } }));
vi.mock('../../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: () => ({ createAdapter: runtimeAdapter }),
}));
vi.mock('../lifecycle/copilot-route-preflight', () => ({
  attachCopilotRoute: async (_provider: unknown, options: unknown) => options,
  stampCopilotRouteOnInstance: () => undefined,
}));
vi.mock('../lifecycle/account-route-preflight', () => ({
  attachAccountRoute: async (_provider: unknown, options: unknown) => options,
  persistedAccountProfileId: () => undefined,
  stampAccountRouteOnInstance: () => undefined,
}));
vi.mock('../../session/handoff-state-service', () => ({
  getHandoffStateService: () => ({ removeInstance: () => undefined }),
}));

describe('task tools production lifecycle wiring', () => {
  beforeEach(() => {
    _resetTaskToolsScopingForTesting();
    runtimeAdapter.mockReset().mockImplementation(() => ({}));
    vi.stubEnv('CLAUDE_CODE_ENABLE_TODO_TOOLS', undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { metadata: {}, expected: '1' },
    { metadata: { repoJobId: 'job', spendPurpose: 'repo-job' }, expected: undefined },
    { metadata: { repoJobId: 'job' }, expected: undefined },
    { metadata: { spendPurpose: 'repo-job' }, expected: undefined },
    { metadata: { automationId: 'automation', automationRunId: 'run', spendPurpose: 'automation' }, expected: undefined },
    { metadata: { planQueueRunId: 'queue', planQueueItemId: 'item', planQueueRole: 'worker' }, expected: undefined },
    { metadata: { pingPongReviewer: true, spendPurpose: 'review' }, expected: undefined },
  ])('sets the actual factory environment through lifecycle for $metadata', async ({ metadata, expected }) => {
    const instance = { id: 'chat', parentId: null, provider: 'claude', metadata, executionLocation: { type: 'local' } };
    const lifecycle = Object.assign(Object.create(InstanceLifecycleManager.prototype), {
      deps: { getInstance: () => instance },
      settings: { getAll: () => ({ claudeShowTaskList: true }) },
      spawnConfigBuilder: { getHarnessCliEnv: () => undefined },
    }) as {
      createRuntimeAdapter(provider: string, options: { instanceId: string; workingDirectory: string }, location: ExecutionLocation): Promise<unknown>;
    };
    runtimeAdapter.mockImplementation(({ cliType, options, executionLocation }) => createCliAdapter(cliType, options, executionLocation));
    const adapter = await lifecycle.createRuntimeAdapter('claude', { instanceId: 'chat', workingDirectory: '/tmp' }, { type: 'local' });
    expect(adapter).toBeInstanceOf(ClaudeCliAdapter);
    expect((adapter as ClaudeCliAdapter).getConfig().env?.['CLAUDE_CODE_ENABLE_TODO_TOOLS']).toBe(expected);
    if ('planQueueRole' in metadata) {
      expect((adapter as ClaudeCliAdapter).getConfig().env?.['AIO_QUEUE_SESSION']).toBe('1');
      const args = (adapter as unknown as { buildArgs(message: { role: 'user'; content: string }): string[] })
        .buildArgs({ role: 'user', content: 'test' });
      expect(args[args.indexOf('--disallowedTools') + 1]?.split(',')).toContain('Bash(git push:*)');
    }
  });

  it('refreshes task scope at the runtime construction choke point using current setting and resolved placement', async () => {
    const instance = { id: 'chat', parentId: null, provider: 'claude', executionLocation: { type: 'local' } };
    let enabled = false;
    const lifecycle = Object.assign(Object.create(InstanceLifecycleManager.prototype), {
      deps: { getInstance: () => instance },
      settings: { getAll: () => ({ claudeShowTaskList: enabled }) },
      spawnConfigBuilder: { getHarnessCliEnv: () => undefined },
    }) as {
      createRuntimeAdapter(provider: string, options: { instanceId: string }, location: ExecutionLocation): Promise<unknown>;
    };
    await lifecycle.createRuntimeAdapter('claude', { instanceId: 'chat' }, { type: 'local' });
    expect(isInstanceTaskTools('chat')).toBe(false);
    enabled = true;
    await lifecycle.createRuntimeAdapter('claude', { instanceId: 'chat' }, { type: 'local' });
    expect(isInstanceTaskTools('chat')).toBe(true);
    await lifecycle.createRuntimeAdapter('claude', { instanceId: 'chat' }, { type: 'remote', nodeId: 'worker' });
    expect(isInstanceTaskTools('chat')).toBe(false);
    await lifecycle.createRuntimeAdapter('codex', { instanceId: 'chat' }, { type: 'local' });
    expect(isInstanceTaskTools('chat')).toBe(false);
  });

  it('clears the task scope on the actual manager removed-event path', () => {
    const lifecycle = new EventEmitter();
    const manager = Object.assign(Object.create(InstanceManager.prototype), {
      lifecycle,
      state: Object.assign(new EventEmitter(), { getInstance: () => undefined }),
      communication: new EventEmitter(),
      continuityRecovery: { removeInstance: () => undefined },
      providerEventBus: { removeInstance: () => undefined },
      settledTracker: { clear: () => undefined },
      mcpStartupRecovery: { forget: () => undefined },
      lifecycleEvents: { recordRemoved: () => ({}) },
      emitObserversSafely: () => undefined,
    }) as { setupEventForwarding(): void };
    manager.setupEventForwarding();
    setInstanceTaskTools('chat', true);
    lifecycle.emit('removed', 'chat');
    expect(isInstanceTaskTools('chat')).toBe(false);
  });
});
