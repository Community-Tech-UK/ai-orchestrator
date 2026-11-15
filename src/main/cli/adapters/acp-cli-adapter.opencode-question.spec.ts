import { describe, expect, it, vi } from 'vitest';
import type { AcpJsonRpcSuccessResponse } from '../../../shared/types/cli.types';
import { createInitializedAgentHarness, TestAcpCliAdapter, type FakeAcpProcess } from './acp-cli-adapter.test-helpers';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const QUESTION_OPTIONS = [
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

function questionPermission(proc: FakeAcpProcess, id: number) {
  proc.request(id, 'session/request_permission', {
    sessionId: 'sess-acp-1',
    toolCall: { toolCallId: 'call_q1', name: 'question', title: 'question', kind: 'other', rawInput: { questions: [{ question: 'red or blue?' }] } },
    options: QUESTION_OPTIONS,
  });
}

function questionForm(proc: FakeAcpProcess, id: number) {
  proc.request(id, 'elicitation/create', {
    mode: 'form',
    sessionId: 'sess-acp-1',
    toolCallId: 'call_q1',
    message: 'Questions',
    requestedSchema: { type: 'object', properties: { q0: { type: 'string', title: 'Colour', description: 'red or blue?', oneOf: [{ const: 'red', title: 'red' }, { const: 'blue', title: 'blue' }] } } },
  });
}

describe('OpenCode 2 question tool', () => {
  it('grants the question permission gate and answers through the question form (LT-1018)', async () => {
    const proc = createInitializedAgentHarness();
    let gateOutcome: unknown;
    let formResult: unknown;
    proc.onRequest('session/prompt', async (request) => {
      questionPermission(proc, 90);
      gateOutcome = (await proc.waitForMessage((message) => 'id' in message && message.id === 90 && 'result' in message) as AcpJsonRpcSuccessResponse).result;
      questionForm(proc, 91);
      formResult = (await proc.waitForMessage((message) => 'id' in message && message.id === 91 && 'result' in message) as AcpJsonRpcSuccessResponse).result;
      proc.respond(request.id, { stopReason: 'end_turn' });
    });
    const adapter = new TestAcpCliAdapter(proc, { adapterName: 'opencode-acp', workingDirectory: '/tmp', permissionContext: { instanceId: 'inst-1', yoloMode: false } });
    adapter.configureOpenCodeV2(true);
    const cards: { metadata: Record<string, unknown> }[] = [];
    adapter.on('input_required', (payload: { metadata: Record<string, unknown> }) => cards.push(payload));
    await adapter.spawn();

    const turn = adapter.sendMessage({ role: 'user', content: 'pick a colour' });
    await vi.waitFor(() => expect(cards.some((card) => card.metadata['type'] === 'acp_elicitation')).toBe(true));
    await adapter.sendRaw('red');
    await turn;

    expect(gateOutcome).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } });
    expect(cards.map((card) => card.metadata['type'])).toEqual(['acp_elicitation']);
    expect(formResult).toEqual({ action: 'accept', content: { q0: 'red' } });
    proc.exit();
  });

  it('keeps the approval card for the question tool when OpenCode 2 support is not enabled', async () => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', async (request) => {
      questionPermission(proc, 92);
      proc.respond(request.id, { stopReason: 'end_turn' });
    });
    const adapter = new TestAcpCliAdapter(proc, { adapterName: 'opencode-acp', workingDirectory: '/tmp', permissionContext: { instanceId: 'inst-1', yoloMode: false } });
    const cards: { metadata: Record<string, unknown> }[] = [];
    adapter.on('input_required', (payload: { metadata: Record<string, unknown> }) => cards.push(payload));
    await adapter.spawn();

    await adapter.sendMessage({ role: 'user', content: 'pick a colour' });

    expect(cards.map((card) => card.metadata['type'])).toEqual(['acp_permission_request']);
    proc.exit();
  });
});
