import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexCliAdapter } from './codex-cli-adapter';
import { createCliAdapter, resolveCliType } from './adapter-factory';
import { collectStdin, queueCodexRun } from './codex-cli-adapter.test-helpers';
import { bindBackgroundWorkTerminationReporter } from '../../instance/instance-background-work-runtime';
import type { Instance } from '../../../shared/types/instance.types';
import type { AppServerNotification } from './codex/app-server-types';

vi.mock('../cli-detection', async (original) => ({
  ...await original<typeof import('../cli-detection')>(),
  CliDetectionService: { getInstance: () => ({ detectAll: async () => ({
    detected: [], available: [{ name: 'codex' }], unavailable: [], timestamp: new Date(),
  }) }) },
}));
vi.mock('../../core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: () => undefined, getAll: () => ({}) }) }));


function bindManaged(adapter: CodexCliAdapter): void {
  const instance = { id: 'placeholder-managed-session' } as Instance;
  bindBackgroundWorkTerminationReporter(instance.id, adapter, {
    getInstance: () => instance, getAdapter: () => adapter,
  }, () => undefined);
}
async function sentInput(adapter: CodexCliAdapter): Promise<string> {
  const spawn = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
  const child = queueCodexRun(spawn, { stdoutLines: [
    '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
  ] });
  const input = collectStdin(child);
  await adapter.sendMessage({ role: 'user', content: 'Run the long command.' });
  return input;
}
function assertRule(input: string): void {
  expect(input).toContain('Start long commands as your own background command');
  expect(input).toContain("Do not use another agent's monitor or schedule tools");
  expect(input).toContain('Only claim the work is being monitored when Harness shows it as background work');
}

const activeAdapters: CodexCliAdapter[] = [];
afterEach(async () => {
  for (const adapter of activeAdapters.splice(0)) await adapter.terminate(false);
  vi.restoreAllMocks();
});

async function startAppServer(adapter: CodexCliAdapter) {
  const subscribers = new Set<(notification: AppServerNotification) => void>();
  let exit!: () => void;
  let turn = 0;
  const client = {
    exitPromise: new Promise<void>((resolve) => { exit = resolve; }),
    isRunning: () => true,
    getPid: () => undefined,
    close: async () => { exit(); },
    subscribeNotifications: (handler: (notification: AppServerNotification) => void) => {
      subscribers.add(handler); return () => { subscribers.delete(handler); };
    },
    request: vi.fn(async (method: string, _params: Record<string, unknown>) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      if (method !== 'turn/start') throw new Error(`Unexpected placeholder request: ${method}`);
      const id = `placeholder-turn-${++turn}`;
      for (const notification of [
        { method: 'turn/started', params: { threadId: 'placeholder-thread', turn: { id } } },
        { method: 'item/completed', params: { threadId: 'placeholder-thread', turnId: id,
          item: { id: 'placeholder-answer', type: 'agentMessage', phase: 'final_answer', text: 'Done.' } } },
        { method: 'turn/completed', params: { threadId: 'placeholder-thread', turn: { id, status: 'completed' } } },
      ] as AppServerNotification[]) {
        for (const subscriber of subscribers) subscriber(notification);
      }
      return { turn: { id, status: 'inProgress' } };
    }),
  };
  const internal = adapter as unknown as {
    appServerClient: typeof client; appServerThreadId: string;
    initAppServerMode(): Promise<void>;
    prepareCodexHome(kind: 'exec' | 'app-server'): void;
    appServerSendMessageInner(message: string): Promise<void>;
  };
  vi.spyOn(adapter, 'checkStatus').mockResolvedValue({ available: true, metadata: { appServerAvailable: true } });
  vi.spyOn(internal, 'prepareCodexHome').mockImplementation(() => undefined);
  vi.spyOn(internal, 'initAppServerMode').mockImplementation(async () => {
    Object.assign(internal, { appServerClient: client, appServerThreadId: 'placeholder-thread' });
  });
  activeAdapters.push(adapter);
  await adapter.spawn();
  return async (message = 'Run the long command.') => {
    client.request.mockClear();
    await internal.appServerSendMessageInner(message);
    const input = client.request.mock.calls.find(([method]) => method === 'turn/start')!;
    return JSON.stringify(input[1]);
  };
}

describe('managed Codex background instructions on the executing provider path', () => {
  it.each([
    [undefined, 'codex'], ['auto', 'auto'], ['claude', 'codex'], ['codex', 'auto'],
  ] as const)('delivers the rule when requested provider=%s and default=%s resolve to app-server Codex', async (requested, fallback) => {
    const resolved = await resolveCliType(requested, fallback);
    expect(resolved).toBe('codex');
    const adapter = createCliAdapter(resolved, { instanceId: 'placeholder-managed-session', workingDirectory: '/tmp/project' });
    expect(adapter).toBeInstanceOf(CodexCliAdapter);
    bindManaged(adapter as CodexCliAdapter);
    const send = await startAppServer(adapter as CodexCliAdapter);
    assertRule(await send());
  });

  it('adds the rule once across rebinding and preserves the caller-owned prompt', async () => {
    const config = { systemPrompt: 'Preserve the existing instruction.', workingDir: '/tmp/project' };
    const adapter = new CodexCliAdapter(config);
    bindManaged(adapter);
    bindManaged(adapter);
    const send = await startAppServer(adapter);
    const input = await send();
    assertRule(input);
    expect(input.split('[Background commands]')).toHaveLength(2);
    expect(input).toContain(config.systemPrompt);
    expect(config.systemPrompt).toBe('Preserve the existing instruction.');
    bindManaged(adapter);
    expect(await send('Continue.')).not.toContain('[Background commands]');
  });

  it('adds the rule to a managed app-server session resuming an existing thread', async () => {
    const adapter = new CodexCliAdapter({ resume: true, sessionId: 'placeholder-existing-thread' });
    bindManaged(adapter);
    const send = await startAppServer(adapter);
    assertRule(await send());
  });

  it('adds the rule when a prewarmed app-server adapter is bound before its first turn', async () => {
    const adapter = new CodexCliAdapter({ systemPrompt: 'Preserve the existing instruction.' });
    const send = await startAppServer(adapter);
    bindManaged(adapter);
    bindManaged(adapter);
    const input = await send();
    assertRule(input);
    expect(input.split('[Background commands]')).toHaveLength(2);
    expect(input).toContain('Preserve the existing instruction.');
  });

  it.each([false, true])('does not promise monitoring to managed exec fallback (resume=%s)', async (resume) => {
    const adapter = new CodexCliAdapter({ systemPrompt: 'Keep the existing instruction.', workingDir: '/tmp/project',
      ...(resume ? { resume: true, sessionId: 'placeholder-existing-thread' } : {}) });
    bindManaged(adapter);
    vi.spyOn(adapter, 'checkStatus').mockResolvedValue({ available: true, metadata: { appServerAvailable: false } });
    const internal = adapter as unknown as { prepareCodexHome(kind: 'exec' | 'app-server'): void };
    vi.spyOn(internal, 'prepareCodexHome').mockImplementation(() => undefined);
    activeAdapters.push(adapter);
    await adapter.spawn();
    expect(await sentInput(adapter)).not.toContain('[Background commands]');
  });

  it('does not promise monitoring to an unbound one-shot Codex adapter', async () => {
    const adapter = new CodexCliAdapter({ systemPrompt: 'Review the code.', workingDir: '/tmp/project', ephemeral: true });
    expect(await sentInput(adapter)).not.toContain('[Background commands]');
  });

  it('does not promise monitoring to an unbound app-server reviewer', async () => {
    const adapter = new CodexCliAdapter({ systemPrompt: 'Review the code.', ephemeral: true });
    const send = await startAppServer(adapter);
    expect(await send()).not.toContain('[Background commands]');
  });
});
