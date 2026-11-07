import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { ClaudeCliAdapter, type ClaudeCliSpawnOptions, type InputRequiredPayload } from './claude-cli-adapter';
import { beginAdapterLoan, endAdapterLoan, _resetAdapterLoansForTesting } from '../../instance/lifecycle/adapter-loan-registry';
import { killProcessGroup } from './base-cli-process-utils';

vi.mock('./base-cli-process-utils', () => ({ killProcessGroup: vi.fn(() => true) }));

const disposers: (() => void)[] = [];
async function setup(options: ClaudeCliSpawnOptions = {}, version: string | undefined = '2.1.300', residentSpawn = true) {
  const packets: Record<string, unknown>[] = [];
  const proc = Object.assign(new EventEmitter(), { pid: 4242, killed: false,
    stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: new Writable({ write(chunk, _encoding, callback) { packets.push(JSON.parse(chunk.toString())); callback(); } }),
  });
  const adapter = new ClaudeCliAdapter({ residentClaude: true, permissionHookPath: '/placeholder/defer-hook.mjs',
    livePermissionPrompts: true, instanceId: 'instance-placeholder', ...options });
  // Cache the local probe result; only the external process is replaced, not argv/NDJSON/formatter/broker behavior.
  (adapter as unknown as { cachedCliStatus: unknown }).cachedCliStatus = { available: true, version, path: 'claude' };
  const spawn = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess')
    .mockReturnValue(proc as unknown as ChildProcess);
  const cards: InputRequiredPayload[] = [];
  const statuses: string[] = [];
  const resolved: { id: string; reason: string }[] = [];
  const outputs: { type: string; content: string }[] = [];
  adapter.on('input_required', card => cards.push(card));
  adapter.on('input_required_resolved', event => resolved.push(event));
  adapter.on('status', status => statuses.push(status));
  adapter.on('output', output => outputs.push(output));
  const feed = (message: unknown, newline = true) => proc.stdout.write(JSON.stringify(message) + (newline ? '\n' : ''));
  const ask = (requestId = 'ask-one') => feed({ type: 'control_request', request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: 'WebFetch', input: { url: 'https://example.com' }, tool_use_id: `tool-${requestId}` } });
  disposers.push(() => { proc.emit('close', 0, null); proc.stdin.destroy(); proc.stdout.destroy(); proc.stderr.destroy(); });
  if (residentSpawn) await adapter.spawn();
  return { adapter, proc, packets, spawn, cards, statuses, resolved, outputs, feed, ask };
}

beforeEach(() => { _resetAdapterLoansForTesting(); vi.clearAllMocks(); });
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); _resetAdapterLoansForTesting(); vi.restoreAllMocks(); });

describe('Claude live permission runtime integration', () => {
  it('dispatches stdout asks to the real broker and writes a correlated protocol allow through the formatter', async () => {
    const { adapter, ask, cards, packets, statuses } = await setup();
    ask();
    expect(cards).toHaveLength(1);
    expect(cards[0].metadata).toMatchObject({ live: true, type: 'deferred_permission', tool_name: 'WebFetch', control_request_id: 'ask-one' });
    expect(statuses.at(-1)).toBe('waiting_for_permission');
    expect(adapter.livePermissions.answer(cards[0].id, { approved: true })).toBe(true);
    await adapter.livePermissions.whenAnswered(cards[0].id);
    expect(packets).toEqual([{ type: 'control_response', response: { subtype: 'success', request_id: 'ask-one',
      response: { behavior: 'allow', updatedInput: { url: 'https://example.com' } } } }]);
    expect(statuses.at(-1)).toBe('busy');
    expect(adapter.livePermissions.hasPending()).toBe(false);
  });

  it('keeps waiting while main and helper assistant frames stream, until the final pending answer', async () => {
    const { adapter, ask, cards, feed, statuses, outputs } = await setup();
    ask('one'); ask('two');
    for (const parent of [undefined, 'task-placeholder']) feed({ type: 'assistant', parent_tool_use_id: parent,
      message: { content: [{ type: 'text', text: 'Still working' }], usage: { input_tokens: 10, output_tokens: 2 } } });
    expect(outputs.filter(output => output.type === 'assistant')).toHaveLength(2);
    expect(statuses).toEqual(['waiting_for_permission', 'waiting_for_permission']);
    adapter.livePermissions.answer(cards[0].id, { approved: false });
    await adapter.livePermissions.whenAnswered(cards[0].id);
    expect(statuses.at(-1)).toBe('waiting_for_permission');
    adapter.livePermissions.answer(cards[1].id, { approved: true });
    await adapter.livePermissions.whenAnswered(cards[1].id);
    expect(statuses.at(-1)).toBe('busy');
  });

  it('withdraws on Stop while preserving separate control-query and resident interrupt acknowledgements', async () => {
    const { adapter, ask, cards, packets, feed, resolved } = await setup();
    ask();
    const query = adapter.requestContextUsage();
    const interrupt = adapter.interrupt();
    expect(resolved).toEqual([{ id: cards[0].id, reason: 'cancelled' }]);
    expect(adapter.livePermissions.hasPending()).toBe(false);
    expect(killProcessGroup).not.toHaveBeenCalled();
    feed({ type: 'control_response', response: { subtype: 'success', request_id: packets[0]['request_id'], response: { totalTokens: 42 } } });
    await expect(query).resolves.toEqual({ ok: true, payload: { totalTokens: 42 } });
    let interrupted = false; void interrupt.completion?.then(() => { interrupted = true; });
    await Promise.resolve(); expect(interrupted).toBe(false);
    feed({ type: 'control_response', response: { subtype: 'success', request_id: packets[1]['request_id'] } });
    await expect(interrupt.completion).resolves.toEqual({ status: 'interrupted' });
  });

  it('withdraws before the non-resident SIGINT fallback too', async () => {
    const { adapter, ask, cards, resolved } = await setup({ residentClaude: false });
    ask();
    expect(adapter.interrupt().status).toBe('accepted');
    expect(resolved).toEqual([{ id: cards[0].id, reason: 'cancelled' }]);
    expect(killProcessGroup).toHaveBeenCalledWith(4242, 'SIGINT');
  });

  it('withdraws all cards on exit, including an ask flushed from the final unterminated NDJSON line', async () => {
    const { adapter, ask, feed, cards, proc, resolved } = await setup();
    ask();
    feed({ type: 'control_request', request_id: 'trailing-ask', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/outside/file' } } }, false);
    proc.emit('close', 1, null);
    expect(cards).toHaveLength(2);
    expect(resolved).toEqual(cards.map(card => ({ id: card.id, reason: 'exited' })));
    expect(adapter.livePermissions.hasPending()).toBe(false);
  });

  it('withdraws pending cards on the separate one-shot close path', async () => {
    const { adapter, ask, cards, resolved, proc, spawn } = await setup({}, '2.1.300', false);
    const response = adapter.sendMessage({ role: 'user', content: 'Read the public page' });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    ask();
    expect(cards).toHaveLength(1);
    proc.emit('close', 0, null);
    await response;
    expect(resolved).toEqual([{ id: cards[0].id, reason: 'exited' }]);
    expect(adapter.livePermissions.hasPending()).toBe(false);
  });

  it('withdraws immediately on explicit teardown even before the child emits close', async () => {
    const { adapter, ask, cards, resolved, proc } = await setup();
    ask();
    const close = vi.fn(); proc.on('close', close);
    await adapter.terminate(false);
    expect(close).not.toHaveBeenCalled();
    expect(resolved).toEqual([{ id: cards[0].id, reason: 'exited' }]);
    expect(adapter.livePermissions.hasPending()).toBe(false);
    expect(killProcessGroup).toHaveBeenCalledWith(4242, 'SIGKILL');
  });

  it('uses the lazily supplied instance id to deny asks while the actual adapter is on loan', async () => {
    const { ask, cards, packets } = await setup();
    const loan = beginAdapterLoan('instance-placeholder', 'loop-placeholder');
    ask('borrowed');
    expect(cards).toHaveLength(0);
    expect(packets[0]).toMatchObject({ response: { request_id: 'borrowed', response: { behavior: 'deny' } } });
    endAdapterLoan(loan); ask('human');
    expect(cards).toHaveLength(1);
  });

  it('preserves held Bash deferral and its expected-exit state', async () => {
    const { adapter, feed, cards, proc } = await setup();
    feed({ type: 'result', session_id: 'held-session', stop_reason: 'tool_deferred',
      deferred_tool_use: { id: 'bash-tool', name: 'Bash', input: { command: 'pwd' } } });
    expect(cards).toHaveLength(1);
    expect(cards[0].metadata).toMatchObject({ type: 'deferred_permission', tool_name: 'Bash', tool_input: { command: 'pwd' } });
    expect(cards[0].metadata?.['live']).toBeUndefined();
    proc.emit('close', 0, null);
    expect(adapter.getDeferredToolUse()).toMatchObject({ toolName: 'Bash', sessionId: 'held-session' });
  });

  it.each([
    ['opted-in resident', {}, '2.1.300', true],
    ['opted-out', { livePermissionPrompts: false }, '2.1.300', false],
    ['no explicit opt-in', { livePermissionPrompts: undefined }, '2.1.300', false],
    ['non-resident', { residentClaude: false }, '2.1.300', false],
    ['auto-approve', { yoloMode: true }, '2.1.300', false],
    ['machine-started', { machineSession: 'loop' }, '2.1.300', false],
    ['read-only review', { readOnlyReview: true }, '2.1.300', false],
    ['old CLI', {}, '2.1.89', false],
    ['unknown CLI', {}, '', false],
    ['no permission hook', { permissionHookPath: undefined }, '2.1.300', false],
  ] as const)('passes stdio permission argv only when supported: %s', async (_label, options, version, enabled) => {
    const { spawn } = await setup(options, version);
    const args = spawn.mock.calls[0][0];
    expect(args.includes('--permission-prompt-tool')).toBe(enabled);
    if (enabled) expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe('stdio');
  });
});
