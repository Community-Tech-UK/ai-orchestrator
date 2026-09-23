import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { PermissionRegistry } from '../../orchestration/permission-registry';
import type { AcpJsonRpcSuccessResponse } from '../../../shared/types/cli.types';
import { createInitializedAgentHarness, TestAcpCliAdapter, type FakeAcpProcess } from './acp-cli-adapter.test-helpers';

const requestPermission = (proc: FakeAcpProcess, id: number) =>
  proc.request(id, 'session/request_permission', {
    sessionId: 'sess-acp-1',
    toolCall: { toolCallId: `call-${id}`, title: 'rm answer.txt', kind: 'execute' },
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
  });

const answerTo = (proc: FakeAcpProcess, id: number) =>
  proc.waitForMessage((incoming) => 'id' in incoming && incoming.id === id && 'result' in incoming) as Promise<AcpJsonRpcSuccessResponse>;

describe('AcpCliAdapter input_required_resolved', () => {
  beforeEach(() => PermissionRegistry._resetForTesting());
  afterEach(() => PermissionRegistry._resetForTesting());

  it('tells listeners a request timed out, after rejecting it to the agent', async () => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', async (message) => {
      requestPermission(proc, 71);
      const answer = await answerTo(proc, 71);
      expect(answer.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
      proc.respond(message.id, { stopReason: 'end_turn' });
    });
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp',
      permissionRegistry: PermissionRegistry.getInstance(),
      permissionContext: { instanceId: 'inst-1' },
      permissionRequestTimeoutMs: 20,
    });
    const shown = vi.fn();
    const resolved = vi.fn();
    adapter.on('input_required', shown);
    adapter.on('input_required_resolved', resolved);
    await adapter.spawn();

    await adapter.sendMessage({ role: 'user', content: 'delete it' });

    expect(shown).toHaveBeenCalledWith(expect.objectContaining({ id: 'acp_permission:71' }));
    expect(resolved).toHaveBeenCalledWith({ id: 'acp_permission:71', reason: 'timeout' });
    proc.exit();
  });

  it('says nothing for a YOLO auto-approval that never showed a card', async () => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', async (message) => {
      requestPermission(proc, 72);
      await answerTo(proc, 72);
      proc.respond(message.id, { stopReason: 'end_turn' });
    });
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp',
      permissionContext: { instanceId: 'inst-1', yoloMode: true },
    });
    const resolved = vi.fn();
    adapter.on('input_required_resolved', resolved);
    await adapter.spawn();

    await adapter.sendMessage({ role: 'user', content: 'delete it' });

    expect(resolved).not.toHaveBeenCalled();
    proc.exit();
  });

  it('does not report a request the user answered', async () => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', async (message) => {
      requestPermission(proc, 73);
      await answerTo(proc, 73);
      proc.respond(message.id, { stopReason: 'end_turn' });
    });
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    const resolved = vi.fn();
    adapter.on('input_required', (payload: { id: string }) => { void adapter.sendRaw('cancel', payload.id); });
    adapter.on('input_required_resolved', resolved);
    await adapter.spawn();

    await adapter.sendMessage({ role: 'user', content: 'delete it' });

    expect(resolved).not.toHaveBeenCalled();
    proc.exit();
  });

  it('withdraws requests still open when the turn is cancelled, closing their registry entries', async () => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', () => requestPermission(proc, 74));
    const registry = PermissionRegistry.getInstance();
    const decisions: unknown[] = [];
    registry.on('permission:resolved', (decision) => decisions.push(decision));
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp',
      permissionRegistry: registry,
      permissionContext: { instanceId: 'inst-1' },
    });
    const resolved = vi.fn();
    adapter.on('input_required_resolved', resolved);
    const shownOnce = new Promise<void>((resolve) => adapter.once('input_required', () => resolve()));
    await adapter.spawn();

    const turn = adapter.sendMessage({ role: 'user', content: 'delete it' }).catch(() => undefined);
    await shownOnce;
    await adapter.terminate(false);
    await turn;

    expect(resolved).toHaveBeenCalledWith({ id: 'acp_permission:74', reason: 'cancelled' });
    expect(registry.getPendingCount()).toBe(0);
    expect(decisions).toEqual([expect.objectContaining({ requestId: 'acp_permission:74', granted: false, decidedBy: 'cancelled' })]);
  });

  it('withdraws open requests when the agent process exits, closing their registry entries', async () => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', () => requestPermission(proc, 75));
    const registry = PermissionRegistry.getInstance();
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp',
      permissionRegistry: registry,
      permissionContext: { instanceId: 'inst-1' },
    });
    const resolved = vi.fn();
    adapter.on('input_required_resolved', resolved);
    const shownOnce = new Promise<void>((resolve) => adapter.once('input_required', () => resolve()));
    await adapter.spawn();

    const turn = adapter.sendMessage({ role: 'user', content: 'delete it' }).catch(() => undefined);
    await shownOnce;
    proc.exit(1);
    await turn;

    expect(resolved).toHaveBeenCalledWith({ id: 'acp_permission:75', reason: 'exited' });
    expect(registry.getPendingCount()).toBe(0);
  });

  it('reports a request once when the agent exits while Stop is still cancelling it', async () => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', () => requestPermission(proc, 77));
    const registry = PermissionRegistry.getInstance();
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp',
      permissionRegistry: registry,
      permissionContext: { instanceId: 'inst-1' },
    });
    const resolved = vi.fn();
    adapter.on('input_required_resolved', resolved);
    const shownOnce = new Promise<void>((resolve) => adapter.once('input_required', () => resolve()));
    await adapter.spawn();
    const turn = adapter.sendMessage({ role: 'user', content: 'delete it' }).catch(() => undefined);
    await shownOnce;
    // The cancel reply is still in flight (e.g. stdin backpressure) when the agent dies.
    (adapter as unknown as { sendResponse: () => Promise<void> }).sendResponse = async () => {
      proc.exit(1);
    };

    await adapter.terminate(false);
    await turn;

    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveBeenCalledWith({ id: 'acp_permission:77', reason: 'exited' });
    expect(registry.getPendingCount()).toBe(0);
  });

  it('reports a timed-out request once when the agent exits while the rejection is being written', async () => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', () => requestPermission(proc, 78));
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp',
      permissionRegistry: PermissionRegistry.getInstance(),
      permissionContext: { instanceId: 'inst-1' },
      permissionRequestTimeoutMs: 20,
    });
    const resolved = vi.fn();
    adapter.on('input_required_resolved', resolved);
    adapter.once('input_required', () => {
      // The timeout's reject reply stalls (stdin backpressure) and the agent dies meanwhile.
      (adapter as unknown as { sendResponse: () => Promise<void> }).sendResponse = async () => {
        proc.exit(1);
      };
    });
    await adapter.spawn();

    await adapter.sendMessage({ role: 'user', content: 'delete it' }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveBeenCalledWith({ id: 'acp_permission:78', reason: 'exited' });
  });

  it('reports an elicitation once when the agent exits while Stop is still cancelling it', async () => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', () => proc.request('ask-2', 'elicitation/create', {
      sessionId: 'sess-acp-1', mode: 'form', message: 'Choose', requestedSchema: { type: 'object', properties: {} },
    }));
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    const resolved = vi.fn();
    adapter.on('input_required_resolved', resolved);
    const shownOnce = new Promise<void>((resolve) => adapter.once('input_required', () => resolve()));
    await adapter.spawn();
    const turn = adapter.sendMessage({ role: 'user', content: 'plan it' }).catch(() => undefined);
    await shownOnce;
    (adapter as unknown as { sendResponse: () => Promise<void> }).sendResponse = async () => {
      proc.exit(1);
    };

    await adapter.terminate(false);
    await turn;

    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ reason: 'exited' }));
  });

  it('clears an open elicitation card when the agent process exits', async () => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', () => proc.request('ask-1', 'elicitation/create', {
      sessionId: 'sess-acp-1',
      mode: 'form',
      message: 'Choose a strategy',
      requestedSchema: { type: 'object', properties: { strategy: { type: 'string' } } },
    }));
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    const resolved = vi.fn();
    adapter.on('input_required_resolved', resolved);
    const shownOnce = new Promise<string>((resolve) => adapter.once('input_required', (payload: { id: string }) => resolve(payload.id)));
    await adapter.spawn();

    const turn = adapter.sendMessage({ role: 'user', content: 'plan it' }).catch(() => undefined);
    const cardId = await shownOnce;
    proc.exit(1);
    await turn;

    expect(resolved).toHaveBeenCalledWith({ id: cardId, reason: 'exited' });
    // A late Cancel on that card is now stale rather than written to a dead process.
    await expect(adapter.sendRaw('cancel', cardId)).rejects.toMatchObject({ code: 'INPUT_REQUIRED_NOT_PENDING' });
  });

  it.each([
    ['allow', true, { outcome: 'selected', optionId: 'allow-once' }],
    ['cancel', false, { outcome: 'cancelled' }],
  ])('closes the registry entry with the user\'s decision on a %s reply', async (reply, granted, expectedOutcome) => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', async (message) => {
      requestPermission(proc, 76);
      const answer = await answerTo(proc, 76);
      expect(answer.result).toEqual({ outcome: expectedOutcome });
      proc.respond(message.id, { stopReason: 'end_turn' });
    });
    const registry = PermissionRegistry.getInstance();
    const decisions: unknown[] = [];
    registry.on('permission:resolved', (decision) => decisions.push(decision));
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp',
      permissionRegistry: registry,
      permissionContext: { instanceId: 'inst-1' },
    });
    adapter.on('input_required', (payload: { id: string }) => { void adapter.sendRaw(reply, payload.id); });
    await adapter.spawn();

    await adapter.sendMessage({ role: 'user', content: 'delete it' });

    // Not left pending (the "blocked on approval" banner) and not recorded as a timeout.
    expect(registry.getPendingCount()).toBe(0);
    expect(decisions).toEqual([expect.objectContaining({ requestId: 'acp_permission:76', granted, decidedBy: 'user' })]);
    proc.exit();
  });

  it('marks a reply to an already-settled request as not pending', async () => {
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    await adapter.spawn();

    await expect(adapter.sendRaw('cancel', 'acp_permission:99')).rejects.toMatchObject({
      code: 'INPUT_REQUIRED_NOT_PENDING',
    });
    proc.exit();
  });
});
