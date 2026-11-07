import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { PermissionRegistry } from '../../orchestration/permission-registry';
import type { AcpJsonRpcErrorResponse, AcpJsonRpcSuccessResponse } from '../../../shared/types/cli.types';
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

const errorTo = (proc: FakeAcpProcess, id: number) =>
  proc.waitForMessage((incoming) => 'id' in incoming && incoming.id === id && 'error' in incoming) as Promise<AcpJsonRpcErrorResponse>;

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
    await vi.waitFor(() => expect(resolved).toHaveBeenCalledWith({ id: 'acp_permission:71', reason: 'timeout' }));
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
    expect(decisions).toEqual([expect.objectContaining({ requestId: 'inst-1:acp_permission:74', granted: false, decidedBy: 'cancelled' })]);
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
    ['what does this do?', false, { outcome: 'selected', optionId: 'reject-once' }],
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
    expect(decisions).toEqual([expect.objectContaining({ requestId: 'inst-1:acp_permission:76', granted, decidedBy: 'user' })]);
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
  it.each([
    ['allow_always', 'allow_always'], ['yes', 'once'], ['allow', 'once'], ['deny', 'reject-once'],
    ['no, do not allow', 'reject-once'], ['please allow this once', 'once'], ['yes, allow it', 'once'],
    ['please explain', 'reject-once'], ['yes, what does this do?', 'reject-once'],
  ])('selects an exact id before labels and reads the user words in typed %s', async (reply, expected) => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', async message => {
      proc.request(80, 'session/request_permission', { sessionId: 'sess-acp-1', toolCall: { toolCallId: 'one', title: 'Write', kind: 'edit' }, options: [
        { optionId: 'allow_always', name: 'Allow', kind: 'allow_always' }, { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always' }, { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
      ] });
      expect((await answerTo(proc, 80)).result).toEqual({ outcome: { outcome: 'selected', optionId: expected } });
      proc.respond(message.id, { stopReason: 'end_turn' });
    });
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', permissionRequestTimeoutMs: 12_000 });
    let expiry = 0;
    adapter.on('input_required', (payload: { id: string; metadata: { expiresAt: number } }) => { expiry = payload.metadata.expiresAt; void adapter.sendRaw(reply, payload.id); });
    await adapter.spawn(); const before = Date.now(); await adapter.sendMessage({ role: 'user', content: 'write' });
    expect(expiry - before).toBeGreaterThanOrEqual(11_000); expect(expiry - before).toBeLessThanOrEqual(13_000);
    proc.exit();
  });

  it('does not turn a direct automatic denial into an allow when an allow option id is deny', async () => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', async (message) => {
      proc.request(81, 'session/request_permission', {
        sessionId: 'sess-acp-1',
        toolCall: {
          toolCallId: 'doom-loop-call',
          title: 'doom_loop',
          kind: 'execute',
          rawInput: { tool: 'bash' },
        },
        options: [{ optionId: 'deny', name: 'Allow once', kind: 'allow_once' }],
      });
      await answerTo(proc, 81);
      proc.respond(message.id, { stopReason: 'end_turn' });
    });
    const adapter = new TestAcpCliAdapter(proc, {
      adapterName: 'opencode-acp',
      workingDirectory: '/tmp',
    });
    await adapter.spawn();

    await adapter.sendMessage({ role: 'user', content: 'repeat the command' });

    expect(await answerTo(proc, 81)).toMatchObject({
      result: { outcome: { outcome: 'cancelled' } },
    });
    proc.exit();
  });

  it('sends a registry denial using a reject option kind when ids collide with decision words', async () => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', async (message) => {
      proc.request(82, 'session/request_permission', {
        sessionId: 'sess-acp-1',
        toolCall: { toolCallId: 'registry-denial-call', title: 'Write file', kind: 'edit' },
        options: [
          { optionId: 'deny', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow', name: 'Reject once', kind: 'reject_once' },
        ],
      });
      await answerTo(proc, 82);
      proc.respond(message.id, { stopReason: 'end_turn' });
    });
    const registry = PermissionRegistry.getInstance();
    const decisions: unknown[] = [];
    registry.on('permission:requested', (request) => registry.resolve(request.id, false, 'parent_deny'));
    registry.on('permission:resolved', (decision) => decisions.push(decision));
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp',
      permissionRegistry: registry,
      permissionContext: { instanceId: 'inst-collision' },
    });
    await adapter.spawn();

    await adapter.sendMessage({ role: 'user', content: 'write file' });

    expect(await answerTo(proc, 82)).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'allow' } },
    });
    expect(decisions).toEqual([expect.objectContaining({
      requestId: 'inst-collision:acp_permission:82',
      granted: false,
      decidedBy: 'parent_deny',
    })]);
    proc.exit();
  });

  it('uses the once-kind option for a positive internal decision when both allow kinds exist', async () => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', async (message) => {
      proc.request(83, 'session/request_permission', {
        sessionId: 'sess-acp-1',
        toolCall: { toolCallId: 'registry-approval-call', title: 'Write file', kind: 'edit' },
        options: [
          { optionId: 'allow', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        ],
      });
      await answerTo(proc, 83);
      proc.respond(message.id, { stopReason: 'end_turn' });
    });
    const registry = PermissionRegistry.getInstance();
    const decisions: unknown[] = [];
    registry.on('permission:requested', (request) => registry.resolve(request.id, true, 'auto_approve'));
    registry.on('permission:resolved', (decision) => decisions.push(decision));
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp',
      permissionRegistry: registry,
      permissionContext: { instanceId: 'inst-approval' },
    });
    await adapter.spawn();

    await adapter.sendMessage({ role: 'user', content: 'write file' });

    expect(await answerTo(proc, 83)).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    });
    expect(decisions).toEqual([expect.objectContaining({
      requestId: 'inst-approval:acp_permission:83',
      granted: true,
      decidedBy: 'auto_approve',
    })]);
    proc.exit();
  });

  it.each([
    [
      'duplicate option IDs',
      'Reject once',
      'shared-choice',
      [
        { optionId: 'shared-choice', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'shared-choice', name: 'Reject once', kind: 'reject_once' },
      ],
    ],
    [
      'unsupported allow kind',
      'Allow for this session',
      'future-choice',
      [
        { optionId: 'future-choice', name: 'Allow for this session', kind: 'allow_session' },
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
      ],
    ],
  ])('does not turn %s into permission consent', async (_label, reply, selectedId, options) => {
    const proc = createInitializedAgentHarness();
    const registry = PermissionRegistry.getInstance();
    const decisions: unknown[] = [];
    registry.on('permission:resolved', (decision) => decisions.push(decision));
    const cards = vi.fn();
    const protocolErrors = vi.fn();
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp',
      permissionRegistry: registry,
      permissionContext: { instanceId: 'inst-malformed-catalog' },
    });
    adapter.on('input_required', cards);
    adapter.on('output', protocolErrors);
    await adapter.spawn();

    const errorResponse = errorTo(proc, 84).then((response) => ({ kind: 'error' as const, response }));
    const cardShown = new Promise<{ kind: 'card'; id: string }>((resolve) => {
      adapter.once('input_required', (payload: { id: string }) => resolve({ kind: 'card', id: payload.id }));
    });
    proc.request(84, 'session/request_permission', {
      sessionId: 'sess-acp-1',
      toolCall: { toolCallId: 'malformed-catalog-call', title: 'Write file', kind: 'edit' },
      options,
    });

    try {
      const observed = await Promise.race([errorResponse, cardShown]);
      if (observed.kind === 'card') {
        await adapter.sendRaw(reply, observed.id);
        const answer = await answerTo(proc, 84);
        expect(answer.result).toEqual({ outcome: { outcome: 'selected', optionId: selectedId } });
        expect(decisions).toEqual([expect.objectContaining({
          requestId: 'inst-malformed-catalog:acp_permission:84',
          granted: false,
        })]);
      } else {
        expect(observed.response).toMatchObject({
          jsonrpc: '2.0',
          id: 84,
          error: { code: -32600 },
        });
        expect(proc.receivedMessages).toContainEqual(observed.response);
        expect(cards).not.toHaveBeenCalled();
        expect(protocolErrors).toHaveBeenCalledWith(expect.objectContaining({
          type: 'error',
          metadata: expect.objectContaining({ source: 'acp-protocol-error', recoverable: true }),
        }));
        expect(registry.getPendingCount()).toBe(0);
        expect(decisions).toEqual([]);
        await expect(adapter.sendRaw(reply, 'acp_permission:84')).rejects.toMatchObject({
          code: 'INPUT_REQUIRED_NOT_PENDING',
        });
      }

      expect(observed.kind).toBe('error');
      expect(proc.receivedMessages.some((message) => 'id' in message && message.id === 84 && 'result' in message)).toBe(false);
      expect(registry.getPendingCount()).toBe(0);
      expect(decisions).not.toContainEqual(expect.objectContaining({ granted: true }));
    } finally {
      proc.exit();
    }
  });

  it('keeps valid other-kind choices and opaque IDs selectable without recording a grant', async () => {
    const proc = createInitializedAgentHarness();
    const registry = PermissionRegistry.getInstance();
    const decisions: unknown[] = [];
    registry.on('permission:resolved', (decision) => decisions.push(decision));
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp',
      permissionRegistry: registry,
      permissionContext: { instanceId: 'inst-other-choice' },
    });
    const shown = new Promise<string>((resolve) => {
      adapter.once('input_required', (payload: { id: string }) => resolve(payload.id));
    });
    await adapter.spawn();

    proc.request(85, 'session/request_permission', {
      sessionId: 'sess-acp-1',
      toolCall: { toolCallId: 'other-choice-call', title: 'Run tool', kind: 'execute' },
      options: [{ optionId: 'choice:opaque?1', name: 'Run sandboxed', kind: 'other' }],
    });

    const cardId = await shown;
    await vi.waitFor(() => expect(registry.getPendingCount()).toBe(1));
    const answer = answerTo(proc, 85);
    await adapter.sendRaw('Run sandboxed', cardId);

    expect(await answer).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'choice:opaque?1' } },
    });
    expect(decisions).toEqual([expect.objectContaining({
      requestId: 'inst-other-choice:acp_permission:85',
      granted: false,
      decidedBy: 'user',
    })]);
    proc.exit();
  });

});
