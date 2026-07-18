import type { ChildProcess } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const listBrowserApprovalRequestsMock = vi.hoisted(() =>
  vi.fn<() => Array<{ requestId: string; status: string; expiresAt: number }>>(() => []),
);

// Keep all real exports; only stub the process-tree killer so idle-timeout
// tests don't signal real PIDs.
vi.mock('./codex/app-server-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./codex/app-server-client')>();
  return { ...actual, terminateProcessTree: vi.fn() };
});

vi.mock('../../browser-gateway/browser-approval-store', () => ({
  getBrowserApprovalStore: () => ({
    listRequests: listBrowserApprovalRequestsMock,
  }),
}));

import { CodexCliAdapter, CodexTimeoutError } from './codex-cli-adapter';
import { isRecoverableThreadResumeError } from './codex/exec-error-classifier';
import {
  createMockProcess,
  queueCodexRun,
} from './codex-cli-adapter.test-helpers';

type SyntheticNotification = { method: string; params: Record<string, unknown> };
type SyntheticNotificationHost = {
  notificationHandler: ((notification: SyntheticNotification) => void) | null;
};

function subscribeSyntheticNotification(
  this: SyntheticNotificationHost,
  handler: (notification: SyntheticNotification) => void,
): () => void {
  const previous = this.notificationHandler;
  const combined = (notification: SyntheticNotification): void => {
    previous?.(notification);
    handler(notification);
  };
  this.notificationHandler = combined;
  return () => {
    if (this.notificationHandler === combined) this.notificationHandler = previous;
  };
}

// These tests drive the adapter through real PassThrough streams and real
// `setTimeout`-scheduled process output rather than fake timers, so the default
// 5s per-test timeout is borderline on slower/loaded hosts (notably Windows).
// A modest bump gives the event-loop coordination headroom without dragging the
// suite long enough to trip vitest's worker-RPC heartbeat — assertions are
// unchanged, only the deadline is relaxed.
vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

describe('CodexCliAdapter', () => {
  afterEach(() => {
    listBrowserApprovalRequestsMock.mockReset();
    listBrowserApprovalRequestsMock.mockReturnValue([]);
    vi.restoreAllMocks();
  });

  describe('thread-loss continuity', () => {
    // A successful retry must not hide context loss. Exec mode can replay its
    // local transcript; app-server mode must fail closed so lifecycle recovery
    // can use the orchestrator's persisted history.

    async function spawnExecAdapter(): Promise<CodexCliAdapter> {
      const adapter = new CodexCliAdapter();
      vi.spyOn(adapter, 'checkStatus').mockResolvedValue({
        available: true,
        authenticated: true,
        path: 'codex',
        version: '0.107.0',
        metadata: { appServerAvailable: false },
      });
      await adapter.spawn();
      return adapter;
    }

    describe('isRecoverableThreadResumeError classifier', () => {
      it('matches thread-loss phrases with thread/session context', () => {
        const classify = (msg: string): boolean =>
          isRecoverableThreadResumeError(new Error(msg));

        expect(classify('Thread does not exist')).toBe(true);
        expect(classify('thread not found: thread-abc')).toBe(true);
        expect(classify('no such thread: xyz')).toBe(true);
        expect(classify('unknown thread')).toBe(true);
        expect(classify('session expired')).toBe(true);
        expect(classify('invalid thread id')).toBe(true);
        expect(classify('missing thread')).toBe(true);
        expect(classify('thread/resume failed: no rollout found for thread id 019de664-fb9c-7ae3-b91c-0893e58c0b10')).toBe(true);
      });

      it('ignores loss phrases that lack thread/session context', () => {
        const classify = (msg: string): boolean =>
          isRecoverableThreadResumeError(new Error(msg));

        // "not found" alone could be a missing file, missing config, etc. —
        // reopening the thread for those would be wrong.
        expect(classify('file not found')).toBe(false);
        expect(classify('config not found')).toBe(false);
        expect(classify('model does not exist')).toBe(false);
        expect(classify('http 500 internal server error')).toBe(false);
        expect(classify('unauthorized')).toBe(false);
        expect(classify('Codex turn stalled: no notifications received for 90000ms')).toBe(false);
      });
    });

    describe('app-server mode', () => {
      it('maps full-auto app-server threads to danger-full-access sandbox', async () => {
        const adapter = new CodexCliAdapter({
          approvalMode: 'full-auto',
          sandboxMode: 'workspace-write',
          workingDir: '/tmp/project',
        });
        const request = vi.fn().mockResolvedValue({ threadId: 'thread-full-auto' });
        const neverExits = new Promise<void>(() => {
          // Intentionally pending.
        });
        vi.spyOn(
          adapter as unknown as { connectAppServer(cwd: string): Promise<unknown> },
          'connectAppServer',
        ).mockResolvedValue({
          request,
          exitPromise: neverExits,
          getExitError: () => null,
          subscribeNotifications: vi.fn(() => () => {}),
        });

        await (adapter as unknown as { initAppServerMode(): Promise<void> }).initAppServerMode();

        expect(request).toHaveBeenCalledWith('thread/start', expect.objectContaining({
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
        }));
      });

      async function prepareAppServerAdapter(): Promise<CodexCliAdapter> {
        const adapter = await spawnExecAdapter();
        (adapter as unknown as { useAppServer: boolean }).useAppServer = true;
        (adapter as unknown as { appServerClient: unknown }).appServerClient = {};
        (adapter as unknown as { appServerThreadId: string }).appServerThreadId = 'thread-old';
        return adapter;
      }

      it('preserves the existing thread identity when mid-turn reports thread-not-found', async () => {
        const adapter = await prepareAppServerAdapter();

        const innerSpy = vi.spyOn(
          adapter as unknown as { appServerSendMessageInner(m: string, a?: unknown): Promise<void> },
          'appServerSendMessageInner'
        );
        innerSpy.mockRejectedValue(new Error('Thread does not exist: thread-old'));

        const reopenSpy = vi.spyOn(
          adapter as unknown as { reopenAppServerThread(): Promise<void> },
          'reopenAppServerThread'
        );
        const statuses: string[] = [];
        adapter.on('status', (s: string) => statuses.push(s));

        await expect(adapter.sendInput('retry me')).rejects.toThrow(/thread does not exist/i);

        expect(innerSpy).toHaveBeenCalledTimes(1);
        expect(reopenSpy).not.toHaveBeenCalled();
        expect(statuses).toEqual(['busy', 'error']);
        expect((adapter as unknown as { appServerThreadId: string }).appServerThreadId).toBe('thread-old');
      });

      it('keeps the existing thread when app-server turn notifications stall', async () => {
        const adapter = await prepareAppServerAdapter();

        const innerSpy = vi.spyOn(
          adapter as unknown as { appServerSendMessageInner(m: string, a?: unknown): Promise<void> },
          'appServerSendMessageInner'
        );
        innerSpy.mockRejectedValueOnce(new Error('Codex turn stalled: no notifications received for 90000ms'));
        innerSpy.mockResolvedValueOnce(undefined);

        const reopenSpy = vi.spyOn(
          adapter as unknown as { reopenAppServerThread(): Promise<void> },
          'reopenAppServerThread'
        );
        reopenSpy.mockImplementation(async () => {
          (adapter as unknown as { appServerThreadId: string }).appServerThreadId = 'thread-new-after-stall';
        });

        const statuses: string[] = [];
        adapter.on('status', (s: string) => statuses.push(s));

        await expect(adapter.sendInput('retry me')).rejects.toThrow(/no notifications received/i);

        expect(innerSpy).toHaveBeenCalledTimes(1);
        expect(reopenSpy).not.toHaveBeenCalled();
        expect(statuses).toEqual(['busy', 'idle']);
        expect((adapter as unknown as { appServerThreadId: string }).appServerThreadId).toBe('thread-old');
      });

      it('uses the active-turn silence budget after an item completes', async () => {
        const adapter = new CodexCliAdapter();
        const neverExits = new Promise<void>(() => {
          // Intentionally pending.
        });
        const client: SyntheticNotificationHost & {
          exitPromise: Promise<void>;
          request: ReturnType<typeof vi.fn<() => Promise<{ turn: { id: string; status: string } }>>>;
          setNotificationHandler(handler: SyntheticNotificationHost['notificationHandler']): void;
          subscribeNotifications: typeof subscribeSyntheticNotification;
        } = {
          notificationHandler: null,
          exitPromise: neverExits,
          request: vi.fn(async () => {
            client.notificationHandler?.({
              method: 'turn/started',
              params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
            });
            client.notificationHandler?.({
              method: 'item/completed',
              params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: { id: 'item-1', type: 'reasoning' },
              },
            });
            return { turn: { id: 'turn-1', status: 'inProgress' } };
          }),
          setNotificationHandler(handler: typeof client.notificationHandler): void {
            this.notificationHandler = handler;
          },
          subscribeNotifications: subscribeSyntheticNotification,
        };
        (adapter as unknown as { appServerClient: typeof client }).appServerClient = client;
        (adapter as unknown as { appServerThreadId: string }).appServerThreadId = 'thread-1';

        vi.useFakeTimers();
        try {
          const capturePromise = (adapter as unknown as {
            captureTurn(input: unknown[]): Promise<unknown>;
          }).captureTurn([{ type: 'text', text: 'continue working', text_elements: [] }]);
          let settled = false;
          capturePromise.then(
            () => { settled = true; },
            () => { settled = true; },
          );

          await vi.advanceTimersByTimeAsync(90_001);
          expect(settled).toBe(false);

          client.notificationHandler?.({
            method: 'turn/completed',
            params: {
              threadId: 'thread-1',
              turn: { id: 'turn-1', status: 'completed' },
            },
          });
          await expect(capturePromise).resolves.toMatchObject({ completed: true });
        } finally {
          vi.useRealTimers();
        }
      });

      it('keeps the app-server notification watchdog alive while browser approval is pending', async () => {
        const adapter = new CodexCliAdapter({
          browserGatewayInstanceId: 'instance-1',
          timeout: 90_000,
        });
        const neverExits = new Promise<void>(() => {
          // Intentionally pending.
        });
        const client: SyntheticNotificationHost & {
          exitPromise: Promise<void>;
          request: ReturnType<typeof vi.fn<() => Promise<{ turn: { id: string; status: string } }>>>;
          setNotificationHandler(handler: SyntheticNotificationHost['notificationHandler']): void;
          subscribeNotifications: typeof subscribeSyntheticNotification;
        } = {
          notificationHandler: null,
          exitPromise: neverExits,
          request: vi.fn().mockResolvedValue({
            turn: { id: 'turn-1', status: 'inProgress' },
          }),
          setNotificationHandler(handler: typeof client.notificationHandler): void {
            this.notificationHandler = handler;
          },
          subscribeNotifications: subscribeSyntheticNotification,
        };
        (adapter as unknown as { appServerClient: typeof client }).appServerClient = client;
        (adapter as unknown as { appServerThreadId: string }).appServerThreadId = 'thread-1';
        listBrowserApprovalRequestsMock.mockReturnValue([
          {
            requestId: 'browser-approval-1',
            status: 'pending',
            expiresAt: Date.now() + 30 * 60 * 1000,
          },
        ]);

        const heartbeats: number[] = [];
        adapter.on('heartbeat', () => heartbeats.push(Date.now()));

        vi.useFakeTimers();
        try {
          const capturePromise = (adapter as unknown as {
            captureTurn(input: unknown[]): Promise<unknown>;
          }).captureTurn([{ type: 'text', text: 'click the button', text_elements: [] }]);
          let settled = false;
          capturePromise.then(
            () => { settled = true; },
            () => { settled = true; },
          );
          await vi.advanceTimersByTimeAsync(90_001);

          expect(settled).toBe(false);
          expect(heartbeats.length).toBeGreaterThanOrEqual(1);

          listBrowserApprovalRequestsMock.mockReturnValue([]);
          client.notificationHandler?.({
            method: 'turn/completed',
            params: {
              threadId: 'thread-1',
              turn: { id: 'turn-1', status: 'completed' },
            },
          });

          await expect(capturePromise).resolves.toMatchObject({
            completed: true,
          });
        } finally {
          vi.useRealTimers();
        }
      });

      it('does not retry on non-thread-loss errors (e.g. HTTP 500)', async () => {
        const adapter = await prepareAppServerAdapter();

        const innerSpy = vi.spyOn(
          adapter as unknown as { appServerSendMessageInner(m: string, a?: unknown): Promise<void> },
          'appServerSendMessageInner'
        );
        innerSpy.mockRejectedValue(new Error('http 500 Internal Server Error'));

        const reopenSpy = vi.spyOn(
          adapter as unknown as { reopenAppServerThread(): Promise<void> },
          'reopenAppServerThread'
        );

        await expect(adapter.sendInput('boom')).rejects.toThrow(/http 500/i);

        expect(innerSpy).toHaveBeenCalledTimes(1);
        expect(reopenSpy).not.toHaveBeenCalled();
      });

      it('does not let fresh-thread creation mask the native thread error', async () => {
        const adapter = await prepareAppServerAdapter();

        const innerSpy = vi.spyOn(
          adapter as unknown as { appServerSendMessageInner(m: string, a?: unknown): Promise<void> },
          'appServerSendMessageInner'
        );
        innerSpy.mockRejectedValue(new Error('Thread does not exist'));

        const reopenSpy = vi.spyOn(
          adapter as unknown as { reopenAppServerThread(): Promise<void> },
          'reopenAppServerThread'
        );
        reopenSpy.mockRejectedValue(new Error('app-server crashed during reopen'));

        await expect(adapter.sendInput('retry me')).rejects.toThrow(/thread does not exist/i);

        expect(innerSpy).toHaveBeenCalledTimes(1);
        expect(reopenSpy).not.toHaveBeenCalled();
      });

      it('does not retry a missing app-server thread', async () => {
        const adapter = await prepareAppServerAdapter();

        const innerSpy = vi.spyOn(
          adapter as unknown as { appServerSendMessageInner(m: string, a?: unknown): Promise<void> },
          'appServerSendMessageInner'
        );
        innerSpy.mockRejectedValue(new Error('Thread does not exist'));

        const reopenSpy = vi.spyOn(
          adapter as unknown as { reopenAppServerThread(): Promise<void> },
          'reopenAppServerThread'
        );
        reopenSpy.mockResolvedValue(undefined);

        await expect(adapter.sendInput('retry me')).rejects.toThrow(/thread does not exist/i);

        expect(innerSpy).toHaveBeenCalledTimes(1);
        expect(reopenSpy).not.toHaveBeenCalled();
      });

      // ── Per-turn input-cap recovery ladder ──────────────────────────────
      // Codex enforces a hard ~1 MiB character cap on the assembled request
      // body (history + tool outputs + file contents). The adapter escalates:
      //   1. compact + wait + retry (context-preserving),
      //   2. fresh thread + retry (survivable, context-lossy),
      //   3. neutral error if the assembled turn still overflows.
      const CAP_ERROR = 'Input exceeds the maximum length of 1048576 characters';

      it('rung 1: compacts, waits for it to land, and retries once (keeps thread)', async () => {
        const adapter = await prepareAppServerAdapter();

        const innerSpy = vi.spyOn(
          adapter as unknown as { appServerSendMessageInner(m: string, a?: unknown): Promise<void> },
          'appServerSendMessageInner'
        );
        innerSpy.mockRejectedValueOnce(new Error(CAP_ERROR));
        innerSpy.mockResolvedValueOnce(undefined);

        const compactSpy = vi.spyOn(adapter, 'compactContext').mockResolvedValue(true);
        const reopenSpy = vi.spyOn(
          adapter as unknown as { reopenAppServerThread(): Promise<void> },
          'reopenAppServerThread'
        );

        await adapter.sendInput('big context turn');

        expect(compactSpy).toHaveBeenCalledTimes(1);
        expect(innerSpy).toHaveBeenCalledTimes(2);
        // Compaction fit the turn — the thread must NOT be reset.
        expect(reopenSpy).not.toHaveBeenCalled();
      });

      it('rung 2: reopens a fresh thread when a single item still overflows after compaction', async () => {
        const adapter = await prepareAppServerAdapter();

        const innerSpy = vi.spyOn(
          adapter as unknown as { appServerSendMessageInner(m: string, a?: unknown): Promise<void> },
          'appServerSendMessageInner'
        );
        innerSpy.mockRejectedValueOnce(new Error(CAP_ERROR)); // initial
        innerSpy.mockRejectedValueOnce(new Error(CAP_ERROR)); // post-compaction
        innerSpy.mockResolvedValueOnce(undefined); // post-reopen

        vi.spyOn(adapter, 'compactContext').mockResolvedValue(true);
        const reopenSpy = vi.spyOn(
          adapter as unknown as { reopenAppServerThread(): Promise<void> },
          'reopenAppServerThread'
        ).mockResolvedValue(undefined);

        const outputs: Array<Record<string, unknown>> = [];
        adapter.on('output', (o: Record<string, unknown>) => outputs.push(o));

        await adapter.sendInput('one huge file dump');

        expect(innerSpy).toHaveBeenCalledTimes(3);
        expect(reopenSpy).toHaveBeenCalledTimes(1);
        // The user is told, transparently, that context was reset.
        const resetNotice = outputs.find((o) => (o['metadata'] as Record<string, unknown> | undefined)?.['threadReset']);
        expect(resetNotice).toBeDefined();
        expect(resetNotice?.['type']).toBe('system');
      });

      it('rung 2: skips straight to a fresh thread when compaction is unavailable', async () => {
        const adapter = await prepareAppServerAdapter();

        const innerSpy = vi.spyOn(
          adapter as unknown as { appServerSendMessageInner(m: string, a?: unknown): Promise<void> },
          'appServerSendMessageInner'
        );
        innerSpy.mockRejectedValueOnce(new Error(CAP_ERROR)); // initial
        innerSpy.mockResolvedValueOnce(undefined); // post-reopen

        vi.spyOn(adapter, 'compactContext').mockResolvedValue(false);
        const reopenSpy = vi.spyOn(
          adapter as unknown as { reopenAppServerThread(): Promise<void> },
          'reopenAppServerThread'
        ).mockResolvedValue(undefined);

        await adapter.sendInput('turn we cannot compact');

        expect(innerSpy).toHaveBeenCalledTimes(2);
        expect(reopenSpy).toHaveBeenCalledTimes(1);
      });

      it('rung 3: surfaces a clear error when even a fresh thread overflows', async () => {
        const adapter = await prepareAppServerAdapter();

        const innerSpy = vi.spyOn(
          adapter as unknown as { appServerSendMessageInner(m: string, a?: unknown): Promise<void> },
          'appServerSendMessageInner'
        );
        innerSpy.mockRejectedValue(new Error(CAP_ERROR)); // every attempt overflows

        vi.spyOn(adapter, 'compactContext').mockResolvedValue(true);
        vi.spyOn(
          adapter as unknown as { reopenAppServerThread(): Promise<void> },
          'reopenAppServerThread'
        ).mockResolvedValue(undefined);

        await expect(adapter.sendInput('an assembled turn over the provider cap'))
          .rejects.toThrow(/assembled turn/i);

        // initial + post-compaction + post-reopen = 3, then stop.
        expect(innerSpy).toHaveBeenCalledTimes(3);
      });

      it('a thread/compacted notification settles the compaction gate', async () => {
        const adapter = await prepareAppServerAdapter();
        const settleSpy = vi.spyOn(
          (adapter as unknown as { contextCostController: { recordCompactionObserved(tokens: number): void } }).contextCostController,
          'recordCompactionObserved'
        );

        (adapter as unknown as {
          handleTurnNotification(
            state: unknown,
            n: { method: string; params: Record<string, unknown> },
          ): void;
        }).handleTurnNotification(
          { completed: false, threadId: 'thread-old', threadIds: new Set(), threadLabels: new Map() },
          { method: 'thread/compacted', params: { threadId: 'thread-old' } },
        );

        expect(settleSpy).toHaveBeenCalledTimes(1);
      });

      it('returns compaction success only after thread/compacted is observed', async () => {
        const adapter = await prepareAppServerAdapter();
        const request = vi.fn().mockImplementation(async () => {
          (adapter as unknown as {
            contextCostController: { recordCompactionObserved(tokens: number): void };
          }).contextCostController.recordCompactionObserved(0);
          return {};
        });
        (adapter as unknown as { appServerClient: { request: typeof request } }).appServerClient = { request };

        await expect(adapter.compactContext()).resolves.toBe(true);
        expect(request).toHaveBeenCalledWith('thread/compact/start', { threadId: 'thread-old' });
      });

      it('returns compaction failure when acknowledgement is not followed by observation', async () => {
        vi.useFakeTimers();
        try {
          const adapter = await prepareAppServerAdapter();
          const request = vi.fn().mockResolvedValue({});
          (adapter as unknown as { appServerClient: { request: typeof request } }).appServerClient = { request };

          const compact = adapter.compactContext();
          await vi.advanceTimersByTimeAsync(30_000);

          await expect(compact).resolves.toBe(false);
        } finally {
          vi.useRealTimers();
        }
      });

      it('reopenAppServerThread issues thread/start and updates thread state', async () => {
        const adapter = await prepareAppServerAdapter();
        (adapter as unknown as { systemPromptSent: boolean }).systemPromptSent = true;

        const requestSpy = vi.fn().mockResolvedValue({ threadId: 'thread-fresh' });
        (adapter as unknown as { appServerClient: { request: unknown } }).appServerClient = {
          request: requestSpy,
        };

        await (adapter as unknown as { reopenAppServerThread(): Promise<void> }).reopenAppServerThread();

        expect(requestSpy).toHaveBeenCalledWith('thread/start', expect.objectContaining({
          cwd: expect.any(String),
          approvalPolicy: 'never',
        }));
        expect((adapter as unknown as { appServerThreadId: string }).appServerThreadId).toBe('thread-fresh');
        expect((adapter as unknown as { sessionId: string }).sessionId).toBe('thread-fresh');
        // The new thread has no prior context — system prompt must re-send.
        expect((adapter as unknown as { systemPromptSent: boolean }).systemPromptSent).toBe(false);
      });

      it('records fresh fallback as an unconfirmed resume attempt', async () => {
        const adapter = new CodexCliAdapter({ workingDir: '/tmp/project' });
        (adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn = true;
        (adapter as unknown as { sessionId: string }).sessionId = 'thread-old';
        (adapter as unknown as { sessionScanner: { findSessionForWorkspace: () => Promise<null> } }).sessionScanner = {
          findSessionForWorkspace: vi.fn().mockResolvedValue(null),
        };

        const request = vi.fn().mockImplementation((method: string) => {
          if (method === 'thread/resume') {
            throw new Error('thread not found: thread-old');
          }
          if (method === 'thread/start') {
            return Promise.resolve({ threadId: 'thread-fresh' });
          }
          return Promise.resolve({});
        });
        const neverExits = new Promise<void>(() => {
          // Intentionally pending.
        });
        vi.spyOn(
          adapter as unknown as { connectAppServer(cwd: string): Promise<unknown> },
          'connectAppServer',
        ).mockResolvedValue({
          request,
          exitPromise: neverExits,
          getExitError: () => null,
          subscribeNotifications: vi.fn(() => () => {}),
        });

        await (adapter as unknown as { initAppServerMode(): Promise<void> }).initAppServerMode();

        expect(adapter.getResumeAttemptResult()).toMatchObject({
          source: 'fresh-fallback',
          confirmed: false,
          requestedSessionId: 'thread-old',
          actualSessionId: 'thread-fresh',
        });
      });

      it('does not substitute a thread/list candidate when explicit resume session is missing', async () => {
        const adapter = new CodexCliAdapter({ workingDir: '/tmp/project' });
        (adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn = true;
        (adapter as unknown as { sessionId: string }).sessionId = 'thread-requested';
        const scanSpy = vi.fn().mockResolvedValue({
          threadId: 'thread-scanned',
          sessionFilePath: '/tmp/session.jsonl',
          workspacePath: '/tmp/project',
          timestamp: Date.now(),
        });
        (adapter as unknown as { sessionScanner: { findSessionForWorkspace: typeof scanSpy } }).sessionScanner = {
          findSessionForWorkspace: scanSpy,
        };

        const request = vi.fn().mockImplementation((method: string, params?: { threadId?: string }) => {
          if (method === 'thread/resume' && params?.threadId === 'thread-requested') {
            throw new Error('thread/resume failed: no rollout found for thread id thread-requested');
          }
          if (method === 'thread/resume') {
            return Promise.resolve({ threadId: params?.threadId });
          }
          if (method === 'thread/list') {
            return Promise.resolve({ data: [{ id: 'thread-other-workspace-candidate' }] });
          }
          if (method === 'thread/start') {
            return Promise.resolve({ threadId: 'thread-fresh' });
          }
          return Promise.resolve({});
        });
        const neverExits = new Promise<void>(() => {
          // Intentionally pending.
        });
        vi.spyOn(
          adapter as unknown as { connectAppServer(cwd: string): Promise<unknown> },
          'connectAppServer',
        ).mockResolvedValue({
          request,
          exitPromise: neverExits,
          getExitError: () => null,
          subscribeNotifications: vi.fn(() => () => {}),
        });

        await (adapter as unknown as { initAppServerMode(): Promise<void> }).initAppServerMode();

        expect(request).not.toHaveBeenCalledWith('thread/list', expect.anything());
        expect(scanSpy).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalledWith('thread/resume', expect.objectContaining({
          threadId: 'thread-other-workspace-candidate',
        }));
        expect(request).not.toHaveBeenCalledWith('thread/resume', expect.objectContaining({
          threadId: 'thread-scanned',
        }));
        expect(request).toHaveBeenCalledWith('thread/start', expect.objectContaining({
          cwd: '/tmp/project',
        }));
        expect(adapter.getResumeAttemptResult()).toMatchObject({
          source: 'fresh-fallback',
          confirmed: false,
          requestedSessionId: 'thread-requested',
          actualSessionId: 'thread-fresh',
        });
      });

      it('starts fresh when exact thread/resume returns a different thread id', async () => {
        const adapter = new CodexCliAdapter({ workingDir: '/tmp/project' });
        (adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn = true;
        (adapter as unknown as { sessionId: string }).sessionId = 'thread-requested';

        const request = vi.fn().mockImplementation((method: string) => {
          if (method === 'thread/resume') {
            return Promise.resolve({ threadId: 'thread-other' });
          }
          if (method === 'thread/start') {
            return Promise.resolve({ threadId: 'thread-fresh' });
          }
          return Promise.resolve({});
        });
        const neverExits = new Promise<void>(() => {
          // Intentionally pending.
        });
        vi.spyOn(
          adapter as unknown as { connectAppServer(cwd: string): Promise<unknown> },
          'connectAppServer',
        ).mockResolvedValue({
          request,
          exitPromise: neverExits,
          getExitError: () => null,
          subscribeNotifications: vi.fn(() => () => {}),
        });

        await (adapter as unknown as { initAppServerMode(): Promise<void> }).initAppServerMode();

        expect(request).toHaveBeenCalledWith('thread/start', expect.objectContaining({
          cwd: '/tmp/project',
        }));
        expect((adapter as unknown as { appServerThreadId: string }).appServerThreadId).toBe('thread-fresh');
        expect(adapter.getResumeAttemptResult()).toMatchObject({
          source: 'fresh-fallback',
          confirmed: false,
          requestedSessionId: 'thread-requested',
          actualSessionId: 'thread-fresh',
        });
      });

      it('abandoned init (stale epoch) discards the late client and does not clobber live state', async () => {
        const adapter = new CodexCliAdapter({ workingDir: '/tmp/project' });
        (adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn = true;
        (adapter as unknown as { sessionId: string }).sessionId = 'thread-requested';

        const request = vi.fn().mockImplementation((method: string) => {
          if (method === 'thread/resume') {
            return Promise.resolve({ threadId: 'thread-requested' });
          }
          return Promise.resolve({});
        });
        const close = vi.fn().mockResolvedValue(undefined);
        const neverExits = new Promise<void>(() => {
          // Intentionally pending.
        });
        vi.spyOn(
          adapter as unknown as { connectAppServer(cwd: string): Promise<unknown> },
          'connectAppServer',
        ).mockResolvedValue({
          request,
          close,
          exitPromise: neverExits,
          getExitError: () => null,
        });

        // Simulate the live exec-mode session's state that a late init must not touch.
        const liveCursor = {
          provider: 'openai' as const,
          threadId: 'thread-live-exec',
          workspacePath: '/tmp/project',
          capturedAt: 123,
          scanSource: 'native' as const,
        };
        (adapter as unknown as { resumeCursor: unknown }).resumeCursor = liveCursor;

        // Epoch 1 was handed to this attempt, but the adapter has since moved
        // on (spawn's init budget elapsed → exec fallback bumped the epoch).
        (adapter as unknown as { appServerInitEpoch: number }).appServerInitEpoch = 2;

        await (adapter as unknown as { initAppServerMode(epoch: number): Promise<void> }).initAppServerMode(1);

        expect(close).toHaveBeenCalled();
        expect((adapter as unknown as { appServerClient?: unknown }).appServerClient).toBeFalsy();
        expect((adapter as unknown as { appServerThreadId?: unknown }).appServerThreadId).toBeFalsy();
        // Live state untouched: resume flag not consumed, cursor not overwritten,
        // attempt result not committed.
        expect((adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn).toBe(true);
        expect(adapter.getResumeCursor()).toEqual(liveCursor);
        expect(adapter.getResumeAttemptResult()).toBeNull();
      });
    });

    describe('exec mode', () => {
      it('maps full-auto fresh exec to danger-full-access sandbox and omits deprecated full-auto on resume', async () => {
        const adapter = new CodexCliAdapter({
          approvalMode: 'full-auto',
          sandboxMode: 'workspace-write',
          workingDir: '/tmp/project',
        });
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');

        queueCodexRun(spawnSpy, {
          stdoutLines: [
            '{"type":"thread.started","thread_id":"thread-full-auto"}',
            '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"first"}}',
            '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
          ],
        });

        await adapter.sendMessage({ role: 'user', content: 'first' });

        queueCodexRun(spawnSpy, {
          stdoutLines: [
            '{"type":"thread.started","thread_id":"thread-full-auto"}',
            '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"second"}}',
            '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":6}}',
          ],
        });

        await adapter.sendMessage({ role: 'user', content: 'second' });

        const firstArgs = spawnSpy.mock.calls[0][0] as string[];
        const secondArgs = spawnSpy.mock.calls[1][0] as string[];

        expect(firstArgs).not.toContain('--full-auto');
        expect(firstArgs).toEqual(expect.arrayContaining(['--sandbox', 'danger-full-access']));
        expect(secondArgs.slice(0, 2)).toEqual(['exec', 'resume']);
        expect(secondArgs).toContain('thread-full-auto');
        expect(secondArgs).not.toContain('--full-auto');
        expect(secondArgs).not.toContain('--sandbox');
      });

      it('does not retry the same stale resume command when Codex reports no rollout found', async () => {
        const adapter = await spawnExecAdapter();
        (adapter as unknown as { sessionId: string }).sessionId = '019de664-fb9c-7ae3-b91c-0893e58c0b10';
        (adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn = true;

        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');

        queueCodexRun(spawnSpy, {
          code: 1,
          stderrLines: [
            'Error: thread/resume failed: no rollout found for thread id 019de664-fb9c-7ae3-b91c-0893e58c0b10',
          ],
        });
        queueCodexRun(spawnSpy, {
          stdoutLines: [
            '{"type":"thread.started","thread_id":"thread-fresh-after-rollout"}',
            '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"recovered"}}',
            '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":6}}',
          ],
        });

        const outputs: { content: string; type: string }[] = [];
        adapter.on('output', (msg: { content: string; type: string }) => {
          outputs.push({ content: msg.content, type: msg.type });
        });

        await adapter.sendInput('retry me');

        const firstArgs = spawnSpy.mock.calls[0][0] as string[];
        const secondArgs = spawnSpy.mock.calls[1][0] as string[];
        expect(spawnSpy).toHaveBeenCalledTimes(2);
        expect(firstArgs.slice(0, 2)).toEqual(['exec', 'resume']);
        expect(firstArgs).toContain('019de664-fb9c-7ae3-b91c-0893e58c0b10');
        expect(secondArgs.slice(0, 2)).toEqual(['exec', '--json']);
        expect(secondArgs).not.toContain('resume');
        expect(secondArgs).not.toContain('019de664-fb9c-7ae3-b91c-0893e58c0b10');
        expect(outputs.some((output) => output.type === 'assistant' && output.content === 'recovered')).toBe(true);
      });

      it('recovers direct sendMessage callers from stale Codex exec resume ids', async () => {
        const adapter = await spawnExecAdapter();
        (adapter as unknown as { sessionId: string }).sessionId = '019de664-fb9c-7ae3-b91c-0893e58c0b10';
        (adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn = true;

        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');

        queueCodexRun(spawnSpy, {
          code: 1,
          stderrLines: [
            'Reading prompt from stdin...',
            'Error: thread/resume: thread/resume failed: no rollout found for thread id 019de664-fb9c-7ae3-b91c-0893e58c0b10 (code -32600)',
          ],
        });
        queueCodexRun(spawnSpy, {
          stdoutLines: [
            '{"type":"thread.started","thread_id":"thread-fresh-after-direct-retry"}',
            '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"direct recovered"}}',
            '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":6}}',
          ],
        });

        const response = await adapter.sendMessage({ role: 'user', content: 'retry me directly' });

        const firstArgs = spawnSpy.mock.calls[0][0] as string[];
        const secondArgs = spawnSpy.mock.calls[1][0] as string[];
        expect(response.content).toBe('direct recovered');
        expect(spawnSpy).toHaveBeenCalledTimes(2);
        expect(firstArgs.slice(0, 2)).toEqual(['exec', 'resume']);
        expect(firstArgs).toContain('019de664-fb9c-7ae3-b91c-0893e58c0b10');
        expect(secondArgs.slice(0, 2)).toEqual(['exec', '--json']);
        expect(secondArgs).not.toContain('resume');
        expect(secondArgs).not.toContain('019de664-fb9c-7ae3-b91c-0893e58c0b10');
        expect(adapter.getSessionId()).toBe('thread-fresh-after-direct-retry');
      });

      it('does not mark a thread id emitted by a failed fresh exec as resumable', async () => {
        const adapter = await spawnExecAdapter();

        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');

        queueCodexRun(spawnSpy, {
          code: 1,
          stdoutLines: [
            '{"type":"thread.started","thread_id":"thread-half-created"}',
          ],
          stderrLines: [
            'Reading prompt from stdin...',
          ],
        });

        await expect(
          (adapter as unknown as {
            executePreparedMessage(
              message: { role: 'user'; content: string },
              options: { timeoutMs: number; phase: 'startup' | 'turn' },
            ): Promise<unknown>;
          }).executePreparedMessage(
            { role: 'user', content: 'fresh attempt' },
            { timeoutMs: 1_000, phase: 'startup' },
          )
        // The benign "Reading prompt from stdin..." stderr notice is filtered
        // out of failure reasons; with no stdout error event the surfaced reason
        // falls back to the exit-code message.
        ).rejects.toThrow(/exited with code 1/);

        const firstArgs = spawnSpy.mock.calls[0][0] as string[];
        expect(spawnSpy).toHaveBeenCalledTimes(1);
        expect(firstArgs.slice(0, 2)).toEqual(['exec', '--json']);
        expect((adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn).toBe(false);
        expect(adapter.getSessionId()).not.toBe('thread-half-created');
      });

      it('surfaces the codex turn.failed error from stdout, not the benign stdin notice', async () => {
        const adapter = await spawnExecAdapter();
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');

        const innerError = JSON.stringify({
          type: 'error',
          status: 400,
          error: {
            type: 'invalid_request_error',
            message: "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
          },
        });
        queueCodexRun(spawnSpy, {
          code: 1,
          stdoutLines: [
            '{"type":"thread.started","thread_id":"thread-fail"}',
            JSON.stringify({ type: 'turn.failed', error: { message: innerError } }),
          ],
          stderrLines: ['Reading prompt from stdin...'],
        });

        // The real cause is double-encoded inside turn.failed on stdout; the only
        // stderr line is the benign stdin notice. The surfaced error must be the
        // real one, with the nested JSON unwrapped.
        await expect(
          adapter.sendMessage({ role: 'user', content: 'do work' })
        ).rejects.toThrow(/not supported when using Codex with a ChatGPT account/);
      });

      it('falls back to codex default model when the requested model is unavailable', async () => {
        const adapter = new CodexCliAdapter({ model: 'gpt-5.3-codex' });
        vi.spyOn(adapter, 'checkStatus').mockResolvedValue({
          available: true,
          authenticated: true,
          path: 'codex',
          version: '0.137.0',
          metadata: { appServerAvailable: false },
        });
        await adapter.spawn();
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');

        const innerError = JSON.stringify({
          type: 'error',
          status: 400,
          error: { message: "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account." },
        });
        // First attempt: codex rejects the routed model.
        queueCodexRun(spawnSpy, {
          code: 1,
          stdoutLines: [
            '{"type":"thread.started","thread_id":"thread-bad-model"}',
            JSON.stringify({ type: 'turn.failed', error: { message: innerError } }),
          ],
          stderrLines: ['Reading prompt from stdin...'],
        });
        // Fallback attempt (no --model → codex default): succeeds.
        queueCodexRun(spawnSpy, {
          stdoutLines: [
            '{"type":"thread.started","thread_id":"thread-default"}',
            '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"done"}}',
            '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
          ],
        });

        const res = await adapter.sendMessage({ role: 'user', content: 'do work' });
        expect(res.content).toBe('done');
        expect(spawnSpy).toHaveBeenCalledTimes(2);

        const firstArgs = spawnSpy.mock.calls[0][0] as string[];
        const secondArgs = spawnSpy.mock.calls[1][0] as string[];
        expect(firstArgs).toContain('--model');
        expect(firstArgs).toContain('gpt-5.3-codex');
        // Fallback omits --model so codex uses its own config.toml default.
        expect(secondArgs).not.toContain('--model');
      });

      it('escalates the idle budget startup → turn once codex emits stdout (tolerates long reasoning gaps)', async () => {
        const adapter = await spawnExecAdapter();
        // Turn budget = 2000ms; the startup budget passed below is 80ms.
        (adapter as unknown as { cliConfig: { timeout?: number } }).cliConfig.timeout = 2000;
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
        const proc = createMockProcess();
        spawnSpy.mockReturnValueOnce(proc as unknown as ChildProcess);

        const exec = (adapter as unknown as {
          executePreparedMessage(
            message: { role: 'user'; content: string },
            options: { timeoutMs: number; phase: 'startup' | 'turn' },
          ): Promise<{ response: { content: string } }>;
        }).executePreparedMessage({ role: 'user', content: 'go' }, { timeoutMs: 80, phase: 'startup' });

        // First stdout arrives immediately → budget escalates to the 2000ms turn
        // budget. Then stay silent for 250ms — well past the 80ms startup budget.
        // Without escalation this would have been killed "during startup".
        proc.stdout.write('{"type":"thread.started","thread_id":"t1"}\n');
        await new Promise((resolve) => setTimeout(resolve, 250));
        proc.stdout.write('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"done"}}\n');
        proc.stdout.end();
        proc.stderr.end();
        proc.emitClose(0, null);

        const result = await exec;
        expect(result.response.content).toBe('done');
      });

      it('still fails fast during a cold start that produces no stdout', async () => {
        const adapter = await spawnExecAdapter();
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
        const proc = createMockProcess();
        spawnSpy.mockReturnValueOnce(proc as unknown as ChildProcess);

        const exec = (adapter as unknown as {
          executePreparedMessage(
            message: { role: 'user'; content: string },
            options: { timeoutMs: number; phase: 'startup' | 'turn' },
          ): Promise<unknown>;
        }).executePreparedMessage({ role: 'user', content: 'go' }, { timeoutMs: 60, phase: 'startup' });

        // Only the benign stdin notice on stderr — no stdout ever arrives, so the
        // budget never escalates and the startup watchdog fires.
        proc.stderr.write('Reading prompt from stdin...\n');

        await expect(exec).rejects.toThrow(/produced no output for 60ms during startup \(possible auth or network hang\)/);
      });

      it('returns a partial transcript on idle timeout when allowPartialOnTimeout is set', async () => {
        const adapter = await spawnExecAdapter();
        // Turn budget = 150ms; the 60ms startup budget escalates on first stdout.
        (adapter as unknown as { cliConfig: { timeout?: number } }).cliConfig.timeout = 150;
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
        const proc = createMockProcess();
        spawnSpy.mockReturnValueOnce(proc as unknown as ChildProcess);

        const exec = (adapter as unknown as {
          executePreparedMessage(
            message: { role: 'user'; content: string; metadata?: Record<string, unknown> },
            options: { timeoutMs: number; phase: 'startup' | 'turn' },
          ): Promise<{ response: { content: string; metadata?: Record<string, unknown> } }>;
        }).executePreparedMessage(
          { role: 'user', content: 'go', metadata: { allowPartialOnTimeout: true } },
          { timeoutMs: 60, phase: 'startup' },
        );

        // Codex emits a meaningful message, then stalls (never closes) → the idle
        // watchdog fires. With allowPartialOnTimeout the accumulated transcript is
        // returned instead of being discarded.
        proc.stdout.write('{"type":"thread.started","thread_id":"t1"}\n');
        proc.stdout.write('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"partial progress"}}\n');

        const result = await exec;
        expect(result.response.content).toContain('partial progress');
        expect(result.response.metadata?.['timedOut']).toBe(true);
        expect(result.response.metadata?.['partial']).toBe(true);
      });

      it('still rejects on idle timeout when allowPartialOnTimeout is not set, even with output', async () => {
        const adapter = await spawnExecAdapter();
        (adapter as unknown as { cliConfig: { timeout?: number } }).cliConfig.timeout = 150;
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
        const proc = createMockProcess();
        spawnSpy.mockReturnValueOnce(proc as unknown as ChildProcess);

        const exec = (adapter as unknown as {
          executePreparedMessage(
            message: { role: 'user'; content: string },
            options: { timeoutMs: number; phase: 'startup' | 'turn' },
          ): Promise<unknown>;
        }).executePreparedMessage({ role: 'user', content: 'go' }, { timeoutMs: 60, phase: 'startup' });

        proc.stdout.write('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"work"}}\n');

        await expect(exec).rejects.toThrow(CodexTimeoutError);
      });

      it('clears session id and retries with fresh exec when resume fails with thread-not-found', async () => {
        const adapter = await spawnExecAdapter();
        (adapter as unknown as { sessionId: string }).sessionId = 'thread-old';
        (adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn = true;
        (adapter as unknown as { resumeCursor: unknown }).resumeCursor = {
          provider: 'openai',
          threadId: 'thread-old',
          workspacePath: '/tmp',
          capturedAt: Date.now(),
          scanSource: 'native',
        };

        const executeSpy = vi.spyOn(
          adapter as unknown as {
            executePreparedMessage(): Promise<{
              code: number | null;
              diagnostics: { fatal: boolean }[];
              raw: string;
              response: { content: string; id: string; metadata: Record<string, unknown>; role: 'assistant' };
            }>;
          },
          'executePreparedMessage'
        );
        executeSpy
          .mockImplementationOnce(async () => {
            // At first call, adapter still has the stale resume state.
            throw new Error('Thread does not exist: thread-old');
          })
          .mockImplementationOnce(async () => {
            // Second call: caller has cleared resume state — verify here.
            expect((adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn).toBe(false);
            expect((adapter as unknown as { sessionId: string }).sessionId).not.toBe('thread-old');
            return {
              code: 0,
              diagnostics: [],
              raw: '',
              response: {
                id: 'resp-fresh',
                role: 'assistant',
                content: 'fresh',
                metadata: {},
              },
            };
          });

        const response = await adapter.sendMessage({ role: 'user', content: 'retry me' });

        expect(response.content).toBe('fresh');
        expect(executeSpy).toHaveBeenCalledTimes(2);
        expect((adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn).toBe(false);
        expect((adapter as unknown as { sessionId: string }).sessionId).not.toBe('thread-old');
        expect((adapter as unknown as { resumeCursor: unknown }).resumeCursor).toBeNull();
      });

      it('retries once on a fresh exec when resume finds a dangling custom tool call', async () => {
        const adapter = await spawnExecAdapter();
        (adapter as unknown as { sessionId: string }).sessionId = 'thread-interrupted';
        (adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn = true;

        const executeSpy = vi.spyOn(
          adapter as unknown as { executePreparedMessage(): Promise<unknown> },
          'executePreparedMessage'
        );
        executeSpy
          .mockRejectedValueOnce(new Error(
            'Custom tool call output is missing for call id: call_GrCZFAKplJVcTMQRC9S6s0iE',
          ))
          .mockResolvedValueOnce({
            code: 0,
            diagnostics: [],
            raw: '',
            response: {
              id: 'resp-fresh-after-interruption',
              role: 'assistant',
              content: 'continued safely',
              metadata: {},
            },
          });

        const response = await adapter.sendMessage({ role: 'user', content: 'resume' });

        expect(response.content).toBe('continued safely');
        expect(executeSpy).toHaveBeenCalledTimes(2);
        expect((adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn).toBe(false);
        expect(adapter.getSessionId()).not.toBe('thread-interrupted');
      });

      it('does not retry fatal spawn errors and surfaces an enriched message', async () => {
        const adapter = await spawnExecAdapter();
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
        const proc = createMockProcess();
        spawnSpy.mockReturnValueOnce(proc as unknown as ChildProcess);

        setTimeout(() => {
          // Errno-shaped spawn failure as Node emits it for a missing binary.
          const err = Object.assign(new Error('spawn codex ENOENT'), {
            code: 'ENOENT',
            syscall: 'spawn codex',
          });
          proc.emit('error', err);
        }, 0);

        await expect(adapter.sendMessage({ role: 'user', content: 'go' }))
          .rejects.toThrow(/CLI binary "codex" not found on PATH/);
        // A spawn failure can never succeed on retry — exactly one attempt.
        expect(spawnSpy).toHaveBeenCalledTimes(1);
      });

      it('propagates a fatal spawn error thrown from the model-unavailable fallback attempt', async () => {
        const adapter = new CodexCliAdapter({ model: 'gpt-5.3-codex' });
        vi.spyOn(adapter, 'checkStatus').mockResolvedValue({
          available: true,
          authenticated: true,
          path: 'codex',
          version: '0.137.0',
          metadata: { appServerAvailable: false },
        });
        await adapter.spawn();
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');

        // First attempt: codex rejects the routed model → sendMessage retries
        // once with --model omitted.
        const innerError = JSON.stringify({
          type: 'error',
          status: 400,
          error: { message: "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account." },
        });
        queueCodexRun(spawnSpy, {
          code: 1,
          stdoutLines: [JSON.stringify({ type: 'turn.failed', error: { message: innerError } })],
          stderrLines: ['Reading prompt from stdin...'],
        });
        // Fallback attempt: the spawn itself fails fatally — must propagate
        // enriched, not be swallowed or retried again.
        const proc = createMockProcess();
        spawnSpy.mockReturnValueOnce(proc as unknown as ChildProcess);
        setTimeout(() => {
          proc.emit('error', Object.assign(new Error('spawn codex ENOENT'), {
            code: 'ENOENT',
            syscall: 'spawn codex',
          }));
        }, 0);

        await expect(adapter.sendMessage({ role: 'user', content: 'go' }))
          .rejects.toThrow(/CLI binary "codex" not found on PATH/);
        expect(spawnSpy).toHaveBeenCalledTimes(2);
      });

      it('kills the turn at the absolute deadline even while codex keeps producing output', async () => {
        const adapter = await spawnExecAdapter();
        (adapter as unknown as { cliConfig: { timeout?: number } }).cliConfig.timeout = 250;
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
        const proc = createMockProcess();
        spawnSpy.mockReturnValueOnce(proc as unknown as ChildProcess);

        const exec = (adapter as unknown as {
          executePreparedMessage(
            message: { role: 'user'; content: string },
            options: { timeoutMs: number; phase: 'startup' | 'turn' },
          ): Promise<unknown>;
        }).executePreparedMessage({ role: 'user', content: 'go' }, { timeoutMs: 100, phase: 'startup' });

        // Keep the process chatty so the idle watchdog never fires — only the
        // absolute deadline can kill this turn.
        const writer = setInterval(() => proc.stdout.write('{"type":"item.started"}\n'), 25);
        const err = await exec.then(() => null, (e: unknown) => e);
        clearInterval(writer);

        expect(err).toBeInstanceOf(CodexTimeoutError);
        expect((err as CodexTimeoutError).kind).toBe('deadline');
        expect((err as CodexTimeoutError).message).toMatch(/exceeded its total deadline of 250ms/);
        expect((err as CodexTimeoutError).message).toMatch(/consider raising the configured timeout/);
      });

      it('returns a partial transcript when the deadline fires and allowPartialOnTimeout is set', async () => {
        const adapter = await spawnExecAdapter();
        (adapter as unknown as { cliConfig: { timeout?: number } }).cliConfig.timeout = 250;
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
        const proc = createMockProcess();
        spawnSpy.mockReturnValueOnce(proc as unknown as ChildProcess);

        const exec = (adapter as unknown as {
          executePreparedMessage(
            message: { role: 'user'; content: string; metadata?: Record<string, unknown> },
            options: { timeoutMs: number; phase: 'startup' | 'turn' },
          ): Promise<{ response: { content: string; metadata?: Record<string, unknown> } }>;
        }).executePreparedMessage(
          { role: 'user', content: 'go', metadata: { allowPartialOnTimeout: true } },
          { timeoutMs: 100, phase: 'startup' },
        );

        proc.stdout.write('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"deadline progress"}}\n');
        const writer = setInterval(() => proc.stdout.write('{"type":"item.started"}\n', () => { /* keep alive */ }), 25);
        const result = await exec;
        clearInterval(writer);

        expect(result.response.content).toContain('deadline progress');
        expect(result.response.metadata?.['timedOut']).toBe(true);
        expect(result.response.metadata?.['partial']).toBe(true);
        expect(result.response.metadata?.['timeoutKind']).toBe('deadline');
      });

      it('clears the idle, deadline, and liveness timers when the process closes cleanly', async () => {
        const adapter = await spawnExecAdapter();
        (adapter as unknown as { cliConfig: { timeout?: number } }).cliConfig.timeout = 120_000;
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
        const proc = createMockProcess();
        spawnSpy.mockReturnValueOnce(proc as unknown as ChildProcess);

        vi.useFakeTimers();
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
        try {
          const exec = (adapter as unknown as {
            executePreparedMessage(
              message: { role: 'user'; content: string },
              options: { timeoutMs: number; phase: 'startup' | 'turn' },
            ): Promise<{ response: { content: string } }>;
          }).executePreparedMessage({ role: 'user', content: 'go' }, { timeoutMs: 60_000, phase: 'turn' });

          proc.stdout.write('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"done"}}\n');
          proc.stdout.end();
          proc.stderr.end();
          proc.emitClose(0, null);
          await vi.advanceTimersByTimeAsync(1);

          const result = await exec;
          expect(result.response.content).toBe('done');
          // Idle, deadline, and liveness timers must all be gone — a stale
          // watchdog would terminate an unrelated successor process.
          const timeoutHandleForDelay = (delayMs: number): unknown =>
            setTimeoutSpy.mock.calls
              .map((call, index) => ({
                delay: Number(call[1] ?? 0),
                handle: setTimeoutSpy.mock.results[index]?.value as unknown,
              }))
              .find((entry) => entry.delay === delayMs)?.handle;
          const intervalHandleForDelay = (delayMs: number): unknown =>
            setIntervalSpy.mock.calls
              .map((call, index) => ({
                delay: Number(call[1] ?? 0),
                handle: setIntervalSpy.mock.results[index]?.value as unknown,
              }))
              .find((entry) => entry.delay === delayMs)?.handle;
          const clearedTimeouts = new Set(clearTimeoutSpy.mock.calls.map((call) => call[0] as unknown));
          const clearedIntervals = new Set(clearIntervalSpy.mock.calls.map((call) => call[0] as unknown));
          const idleTimer = timeoutHandleForDelay(60_000);
          const deadlineTimer = timeoutHandleForDelay(120_000);
          const livenessTimer = intervalHandleForDelay(15_000);

          expect(idleTimer).toBeDefined();
          expect(deadlineTimer).toBeDefined();
          expect(livenessTimer).toBeDefined();
          expect(clearedTimeouts.has(idleTimer)).toBe(true);
          expect(clearedTimeouts.has(deadlineTimer)).toBe(true);
          expect(clearedIntervals.has(livenessTimer)).toBe(true);
        } finally {
          setTimeoutSpy.mockRestore();
          clearTimeoutSpy.mockRestore();
          setIntervalSpy.mockRestore();
          clearIntervalSpy.mockRestore();
          vi.useRealTimers();
        }
      });

      it('surfaces the real error from an unterminated final stderr chunk, not the stdin banner', async () => {
        const adapter = await spawnExecAdapter();
        const spawnSpy = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
        const proc = createMockProcess();
        spawnSpy.mockReturnValueOnce(proc as unknown as ChildProcess);

        const exec = (adapter as unknown as {
          executePreparedMessage(
            message: { role: 'user'; content: string },
            options: { timeoutMs: number; phase: 'startup' | 'turn' },
          ): Promise<unknown>;
        }).executePreparedMessage({ role: 'user', content: 'go' }, { timeoutMs: 5_000, phase: 'startup' });

        // Banner + real error in one chunk, with NO trailing newline — the
        // error line lands in the unterminated remainder processed at close.
        proc.stderr.write('Reading prompt from stdin...\nError: thread/resume failed: no rollout found for thread id abc');
        proc.stdout.end();
        proc.stderr.end();
        proc.emitClose(1, null);

        const err = await exec.then(() => null, (e: unknown) => e as Error);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain('no rollout found for thread id abc');
        expect((err as Error).message).not.toContain('Reading prompt from stdin');
      });

      it('does not retry on non-thread-loss errors in exec mode', async () => {
        const adapter = await spawnExecAdapter();

        const innerSpy = vi.spyOn(
          adapter as unknown as { execSendMessageInner(m: string, a?: unknown): Promise<void> },
          'execSendMessageInner'
        );
        innerSpy.mockRejectedValue(new Error('http 500 Internal Server Error'));

        await expect(adapter.sendInput('boom')).rejects.toThrow(/http 500/i);
        expect(innerSpy).toHaveBeenCalledTimes(1);
      });

      it('does not infinite-loop if fresh exec also fails with thread-not-found', async () => {
        const adapter = await spawnExecAdapter();
        (adapter as unknown as { sessionId: string }).sessionId = 'thread-old';
        (adapter as unknown as { shouldResumeNextTurn: boolean }).shouldResumeNextTurn = true;

        const executeSpy = vi.spyOn(
          adapter as unknown as { executePreparedMessage(): Promise<unknown> },
          'executePreparedMessage'
        );
        executeSpy.mockRejectedValue(new Error('Thread does not exist'));

        await expect(adapter.sendMessage({ role: 'user', content: 'retry me' })).rejects.toThrow(/thread does not exist/i);

        expect(executeSpy).toHaveBeenCalledTimes(2);
      });
    });
  });
});
