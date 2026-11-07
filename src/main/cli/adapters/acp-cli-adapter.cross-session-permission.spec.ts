import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { PermissionRegistry } from '../../orchestration/permission-registry';
import {
  createInitializedAgentHarness,
  TestAcpCliAdapter,
  type FakeAcpProcess,
} from './acp-cli-adapter.test-helpers';

/**
 * ACP rpc ids are connection-local: every session's first permission request
 * is `acp_permission:1`, while `PermissionRegistry` is a singleton keyed by
 * request id alone. These pin that registry registration, resolution,
 * cancellation and timeout ids are namespaced per instance — one session's
 * human answer must never settle another session's pending request.
 */
describe('AcpCliAdapter cross-session permission registry ids', () => {
  beforeEach(() => PermissionRegistry._resetForTesting());
  afterEach(() => PermissionRegistry._resetForTesting());

  const startSession = async (
    index: number,
    options: { permissionRequestTimeoutMs?: number } = {},
  ) => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/new', (message) =>
      proc.respond(message.id, { sessionId: `provider-session-${index}` }));
    proc.onRequest('session/prompt', async (message) => {
      proc.request(1, 'session/request_permission', {
        sessionId: `provider-session-${index}`,
        toolCall: { toolCallId: `call-${index}`, title: 'Write harmless.txt', kind: 'edit' },
        options: [
          { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      });
      await proc.waitForMessage((incoming) => 'id' in incoming && incoming.id === 1 && 'result' in incoming);
      proc.respond(message.id, { stopReason: 'end_turn' });
    });
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp',
      permissionRegistry: PermissionRegistry.getInstance(),
      permissionContext: { instanceId: `session-${index}` },
      ...options,
    });
    const shown = new Promise<void>((resolve) => adapter.once('input_required', () => resolve()));
    await adapter.spawn();
    return { proc, adapter, shown };
  };

  const permissionAnswers = (proc: FakeAcpProcess) =>
    proc.receivedMessages.flatMap((message) =>
      'id' in message && message.id === 1 && 'result' in message ? [message.result] : []);

  const pendingIds = () =>
    PermissionRegistry.getInstance().listPending().map((request) => request.id).sort();

  it('allowing one session must not approve another session with the same rpc id', async () => {
    const sessions = [await startSession(0), await startSession(1)];
    const turns: Promise<unknown>[] = [];
    try {
      turns.push(sessions[0].adapter.sendMessage({ role: 'user', content: 'write A' }));
      await sessions[0].shown;
      turns.push(sessions[1].adapter.sendMessage({ role: 'user', content: 'write B' }));
      await sessions[1].shown;

      expect(pendingIds()).toEqual(['session-0:acp_permission:1', 'session-1:acp_permission:1']);

      await sessions[0].adapter.sendRaw('once', 'acp_permission:1');
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(permissionAnswers(sessions[0].proc)).toEqual([
        { outcome: { outcome: 'selected', optionId: 'once' } },
      ]);
      expect(permissionAnswers(sessions[1].proc), 'session B has not received human consent').toEqual([]);
      expect(pendingIds()).toEqual(['session-1:acp_permission:1']);

      await sessions[1].adapter.sendRaw('once', 'acp_permission:1');
      await vi.waitFor(() =>
        expect(permissionAnswers(sessions[1].proc)).toEqual([
          { outcome: { outcome: 'selected', optionId: 'once' } },
        ]));
    } finally {
      sessions.forEach(({ proc }) => proc.exit());
      await Promise.allSettled(turns);
    }
  });

  it('withdrawing one session on cancel leaves the other session pending', async () => {
    const registry = PermissionRegistry.getInstance();
    const decisions: { requestId: string; decidedBy: string }[] = [];
    registry.on('permission:resolved', (decision) => decisions.push(decision));
    const sessions = [await startSession(0), await startSession(1)];
    const turns: Promise<unknown>[] = [];
    try {
      turns.push(sessions[0].adapter.sendMessage({ role: 'user', content: 'write A' }).catch(() => undefined));
      await sessions[0].shown;
      turns.push(sessions[1].adapter.sendMessage({ role: 'user', content: 'write B' }).catch(() => undefined));
      await sessions[1].shown;

      await sessions[0].adapter.terminate(false);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(permissionAnswers(sessions[0].proc)).toEqual([
        { outcome: { outcome: 'cancelled' } },
      ]);
      expect(permissionAnswers(sessions[1].proc), 'session B is still awaiting a human').toEqual([]);
      expect(pendingIds()).toEqual(['session-1:acp_permission:1']);
      expect(decisions).toEqual([
        { requestId: 'session-0:acp_permission:1', granted: false, decidedBy: 'cancelled', decidedAt: expect.any(Number) },
      ]);

      await sessions[1].adapter.sendRaw('reject', 'acp_permission:1');
      await vi.waitFor(() =>
        expect(permissionAnswers(sessions[1].proc)).toEqual([
          { outcome: { outcome: 'selected', optionId: 'reject' } },
        ]));
    } finally {
      sessions.forEach(({ proc }) => proc.exit());
      await Promise.allSettled(turns);
    }
  });

  it('one session timing out does not settle the other session', async () => {
    const sessions = [
      await startSession(0, { permissionRequestTimeoutMs: 25 }),
      await startSession(1, { permissionRequestTimeoutMs: 10_000 }),
    ];
    const turns: Promise<unknown>[] = [];
    try {
      turns.push(sessions[0].adapter.sendMessage({ role: 'user', content: 'write A' }).catch(() => undefined));
      await sessions[0].shown;
      turns.push(sessions[1].adapter.sendMessage({ role: 'user', content: 'write B' }).catch(() => undefined));
      await sessions[1].shown;

      await vi.waitFor(() =>
        expect(permissionAnswers(sessions[0].proc)).toEqual([
          { outcome: { outcome: 'selected', optionId: 'reject' } },
        ]));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(permissionAnswers(sessions[1].proc), 'session B is still awaiting a human').toEqual([]);
      expect(pendingIds()).toEqual(['session-1:acp_permission:1']);

      await sessions[1].adapter.sendRaw('reject', 'acp_permission:1');
      await vi.waitFor(() =>
        expect(permissionAnswers(sessions[1].proc)).toEqual([
          { outcome: { outcome: 'selected', optionId: 'reject' } },
        ]));
    } finally {
      sessions.forEach(({ proc }) => proc.exit());
      await Promise.allSettled(turns);
    }
  });
});
