import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeLivePermissionBroker } from './claude-live-permission';
import { HARNESS_DENY_PREFIX } from './claude-permission-response';
import { describeLiveAsk } from './describe-live-ask';
import { beginAdapterLoan, endAdapterLoan, _resetAdapterLoansForTesting } from '../../instance/lifecycle/adapter-loan-registry';

function setup() {
  const events: { event: string; payload: unknown }[] = [];
  const replies: Record<string, unknown>[] = [];
  const sendRawControl = vi.fn(async (message: Record<string, unknown>) => { replies.push(message); });
  const emit = vi.fn((event: string, payload: unknown) => { events.push({ event, payload }); return true; });
  const broker = new ClaudeLivePermissionBroker({ emit, sendRawControl }, () => 'instance-placeholder');
  const ask = (id = 'control-placeholder', tool = 'WebFetch', input: Record<string, unknown> = { url: 'https://example.com' }) => {
    broker.handle('control_request', { type: 'control_request', request_id: id,
      request: { subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: `tool-${id}`, agent_id: 'agent-placeholder', blocked_path: '/outside' } });
  };
  const cards = () => events.filter(e => e.event === 'input_required').map(e => e.payload as { id: string; metadata: Record<string, unknown> });
  return { broker, ask, events, replies, emit, sendRawControl, cards };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('ClaudeLivePermissionBroker', () => {
  beforeEach(() => _resetAdapterLoansForTesting());
  it('correlates one card, preserves original input and never persists provider permission rules', async () => {
    const { broker, ask, cards, replies, events } = setup();
    ask(); ask();
    expect(cards()).toHaveLength(1);
    const card = cards()[0];
    expect(card.metadata).toMatchObject({ type: 'deferred_permission', live: true, tool_name: 'WebFetch', tool_input: { url: 'https://example.com' }, control_request_id: 'control-placeholder', agent_id: 'agent-placeholder', blocked_path: '/outside' });
    expect(broker.hasPending()).toBe(true);
    expect(broker.answer(card.id, { approved: true })).toBe(true);
    expect(broker.answer(card.id, { approved: true })).toBe(false);
    await flush();
    expect(replies).toEqual([{ type: 'control_response', response: { subtype: 'success', request_id: 'control-placeholder', response: { behavior: 'allow', updatedInput: { url: 'https://example.com' } } } }]);
    expect(broker.hasPending()).toBe(false);
    expect(events.at(-1)).toEqual({ event: 'status', payload: 'busy' });
  });
  it('answers multiasks independently and stays waiting until the last reply is written', async () => {
    const { broker, ask, cards, replies, events } = setup();
    ask('one'); ask('two');
    broker.answer(cards()[0].id, { approved: false, note: 'Use another source; permission denied.' });
    await flush();
    expect(events.filter(e => e.event === 'status').map(e => e.payload)).toEqual(['waiting_for_permission', 'waiting_for_permission']);
    expect(replies[0]).toMatchObject({ response: { request_id: 'one', response: { behavior: 'deny', message: HARNESS_DENY_PREFIX + 'Use another source; permission denied.' } } });
    broker.answer(cards()[1].id, { approved: true, updatedInput: { url: 'https://example.org' } });
    await flush();
    expect(replies[1]).toMatchObject({ response: { request_id: 'two', response: { updatedInput: { url: 'https://example.org' } } } });
    expect(broker.hasPending()).toBe(false);
    expect(broker.answer('unknown', { approved: true })).toBe(false);
  });
  it('withdraws cancellations and exits, including replies still writing, without a late busy event', async () => {
    const { broker, ask, cards, events, sendRawControl } = setup();
    ask('one'); ask('two');
    broker.handle('control_cancel_request', { request_id: 'one' });
    expect(events).toContainEqual({ event: 'input_required_resolved', payload: { id: cards()[0].id, reason: 'cancelled' } });
    let finish!: () => void;
    sendRawControl.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    broker.answer(cards()[1].id, { approved: true });
    const written = broker.whenAnswered(cards()[1].id);
    broker.dropAll('exited');
    expect(events).toContainEqual({ event: 'input_required_resolved', payload: { id: cards()[1].id, reason: 'exited' } });
    expect(broker.hasPending()).toBe(false);
    finish(); await expect(written).rejects.toThrow('Live permission request was withdrawn');
    await flush();
    expect(events).not.toContainEqual({ event: 'status', payload: 'busy' });
  });
  it('withdraws every outstanding card on process exit', () => {
    const { broker, ask, cards, events } = setup(); ask('one'); ask('two');
    broker.dropAll('exited');
    expect(broker.hasPending()).toBe(false);
    for (const card of cards()) expect(events).toContainEqual({ event: 'input_required_resolved', payload: { id: card.id, reason: 'exited' } });
  });
  it('remembers its own card ids after they close so a stale reply is recognizable', async () => {
    const { broker, ask, cards } = setup(); ask();
    const card = cards()[0];
    expect(broker.knowsCard(card.id)).toBe(true);
    expect(broker.knowsCard('never-minted')).toBe(false);
    broker.dropAll('cancelled');
    expect(broker.hasPending()).toBe(false);
    expect(broker.knowsCard(card.id)).toBe(true);
    expect(broker.answer(card.id, { approved: true })).toBe(false);
  });
  it.each(['AskUserQuestion', 'ExitPlanMode'])('denies %s with no permission card', async tool => {
    const { ask, cards, replies } = setup(); ask('interactive', tool); await flush();
    expect(cards()).toHaveLength(0);
    expect(replies[0]).toMatchObject({ response: { response: { behavior: 'deny', message: HARNESS_DENY_PREFIX + 'The question is shown to them on screen; end your turn and wait for their reply.' } } });
  });
  it('refuses borrowed loop work without a card and accepts human asks after the loan ends', async () => {
    const { ask, cards, replies } = setup();
    const loan = beginAdapterLoan('instance-placeholder', 'loop-placeholder');
    ask('loan'); await flush();
    expect(cards()).toHaveLength(0);
    expect(replies[0]).toMatchObject({ response: { response: { behavior: 'deny', message: expect.stringContaining('No person is watching this loop round') } } });
    endAdapterLoan(loan); ask('human'); expect(cards()).toHaveLength(1);
  });
  it('ignores unrelated protocol and fails closed on malformed or throwing asks', async () => {
    const { broker, ask, replies, emit } = setup();
    expect(broker.handle('control_request', { request: { subtype: 'interrupt' } })).toBe(false);
    expect(broker.handle('assistant', {})).toBe(false);
    broker.handle('control_request', { request_id: 'malformed', request: { subtype: 'can_use_tool' } });
    emit.mockImplementationOnce(() => { throw new Error('card failed'); }); ask('throwing'); await flush();
    expect(replies).toHaveLength(2);
    for (const reply of replies) expect(reply).toMatchObject({ response: { subtype: 'error', error: expect.any(String) } });
    expect(broker.hasPending()).toBe(false);
  });
  it('fails closed if a control write rejects', async () => {
    const { broker, ask, cards, sendRawControl, replies } = setup(); ask();
    sendRawControl.mockRejectedValueOnce(new Error('closed stdin'));
    broker.answer(cards()[0].id, { approved: true });
    await expect(broker.whenAnswered(cards()[0].id)).rejects.toThrow('Live permission reply could not be delivered');
    expect(replies[0]).toMatchObject({ response: { subtype: 'error' } });
    expect(broker.hasPending()).toBe(false);
  });
});

describe('describeLiveAsk', () => {
  it('names file, web, sandbox and subagent asks', () => {
    expect(describeLiveAsk('Write', { file_path: '/outside/file' })).toContain('/outside/file');
    expect(describeLiveAsk('WebFetch', { url: 'https://example.com' })).toContain('https://example.com');
    expect(describeLiveAsk('WebSearch', { query: 'reference material' })).toContain('reference material');
    expect(describeLiveAsk('SandboxNetworkAccess', { host: 'example.com' })).toContain('network access to example.com');
    expect(describeLiveAsk('Read', { file_path: '/file' }, 'agent')).toMatch(/^A subagent wants to/);
  });
  it('describes connectors with bounded values and redacts sensitive keys recursively', () => {
    const result = describeLiveAsk('mcp__browser-gateway__browser_health', { authorization: 'PLACEHOLDER', query: 'x'.repeat(200), nested: { password: 'PLACEHOLDER' } });
    expect(result).toContain('browser-gateway > browser_health');
    expect(result).toContain('hidden'); expect(result).not.toContain('PLACEHOLDER'); expect(result).not.toContain('x'.repeat(81));
  });
});
