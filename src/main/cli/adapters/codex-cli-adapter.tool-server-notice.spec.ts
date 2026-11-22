import { afterEach, describe, expect, it, vi } from 'vitest';

const initializer = vi.hoisted(() => ({ initializeCodexAppServer: vi.fn() }));

vi.mock('./codex/app-server-initializer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./codex/app-server-initializer')>();
  return { ...actual, initializeCodexAppServer: initializer.initializeCodexAppServer };
});
vi.mock('../../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({}) }) }));
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { CodexCliAdapter } from './codex-cli-adapter';
import { classifyToolServerStartup } from './codex/tool-server-startup-notice';
import type { OutputMessage } from '../../../shared/types/instance.types';

type Notification = { method: string; params: Record<string, unknown> };
const STARTUP = 'mcpServer/startupStatus/updated';
const startup = (params: Record<string, unknown>): Notification => ({
  method: STARTUP,
  params: { threadId: 'thread-1', name: 'broken_probe', environmentId: null, status: 'failed', error: 'No such file or directory (os error 2)', failureReason: null, ...params },
});

describe('classifyToolServerStartup', () => {
  it('describes a failed start with the safe server name and the provider text as detail', () => {
    expect(classifyToolServerStartup(startup({}).params, 'thread-1')).toEqual({
      category: 'tool-server', fatal: false, level: 'warning', toolServer: 'broken_probe',
      line: 'MCP server broken_probe failed to start: No such file or directory (os error 2)',
    });
  });

  it('ignores starts that did not fail and other threads', () => {
    for (const status of ['starting', 'ready', 'cancelled']) {
      expect(classifyToolServerStartup(startup({ status }).params, 'thread-1')).toBeNull();
    }
    expect(classifyToolServerStartup(startup({ threadId: 'helper-9' }).params, 'thread-1')).toBeNull();
  });

  it('keeps a name outside the closed character set out of the sentence and says when sign-in is needed', () => {
    const diagnostic = classifyToolServerStartup(startup({ threadId: null, name: 'bad name <b>', error: null, failureReason: 'reauthenticationRequired' }).params, null);
    expect(diagnostic).not.toBeNull();
    expect(diagnostic).not.toHaveProperty('toolServer');
    expect(diagnostic?.line).toBe('MCP server bad name <b> failed to start (sign-in required)');
  });
});

describe('Codex app-server tool-server start-up failure', () => {
  afterEach(() => { initializer.initializeCodexAppServer.mockReset(); });

  async function start(arrivesDuringInit: Notification[]) {
    const handlers = new Set<(n: Notification) => void>();
    const client = {
      exitPromise: new Promise<void>(() => { /* stays connected */ }),
      request: vi.fn(),
      setServerRequestHandler: vi.fn(),
      subscribeNotifications: (handler: (n: Notification) => void) => { handlers.add(handler); return () => handlers.delete(handler); },
    };
    const emit = (n: Notification): void => handlers.forEach(h => h(n));
    initializer.initializeCodexAppServer.mockImplementation(async () => {
      arrivesDuringInit.forEach(emit);
      return { client, threadId: 'thread-1', resumeAttempt: { source: 'none' }, resumeCursor: null, effectiveServiceTier: null };
    });
    const adapter = new CodexCliAdapter();
    vi.spyOn(adapter as unknown as { connectAppServer(): Promise<typeof client> }, 'connectAppServer').mockResolvedValue(client);
    const outputs: OutputMessage[] = [];
    adapter.on('output', (o: OutputMessage) => outputs.push(o));
    await (adapter as unknown as { initAppServerMode(): Promise<void> }).initAppServerMode();
    const notices = (): OutputMessage[] => outputs.filter(o => o.metadata?.['diagnostic'] === true);
    return { adapter, emit, notices };
  }

  it('shows one plain message for a failure that arrives while the thread is being created', async () => {
    const { notices } = await start([startup({}), startup({ name: 'second_server' }), startup({ status: 'starting' }), startup({ name: 'other_thread', threadId: 'helper-9' })]);
    expect(notices()).toHaveLength(1);
    const [notice] = notices();
    expect(notice?.type).toBe('system');
    expect(notice?.content).toContain("A tool server didn't start for this Codex session: broken_probe.");
    const presentation = notice?.metadata?.['errorPresentation'] as { category: string; rawDetail: string };
    expect(presentation.category).toBe('tool-server');
    expect(presentation.rawDetail).toBe('MCP server broken_probe failed to start: No such file or directory (os error 2)');
    expect(notice?.content).not.toContain('os error');
  });

  it('shows a failure that arrives afterwards once, and nothing when every server starts', async () => {
    const quiet = await start([startup({ status: 'ready' })]);
    quiet.emit(startup({ status: 'starting' }));
    expect(quiet.notices()).toHaveLength(0);

    const { emit, notices } = await start([]);
    emit(startup({}));
    emit(startup({ name: 'second_server' }));
    expect(notices()).toHaveLength(1);
  });

  it('shows the message again for a failure in a later turn', async () => {
    const { adapter, emit, notices } = await start([startup({})]);
    expect(notices()).toHaveLength(1);
    const runtime = (adapter as unknown as { appServerRuntime: { getActiveTurnState(): object | null } }).appServerRuntime;
    vi.spyOn(runtime, 'getActiveTurnState').mockReturnValue({});
    emit(startup({}));
    emit(startup({ name: 'again' }));
    expect(notices()).toHaveLength(2);
  });
});
