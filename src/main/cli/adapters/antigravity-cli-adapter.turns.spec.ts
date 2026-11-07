import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OutputMessage } from '../../../shared/types/instance.types';
import { ANTIGRAVITY_SILENCE_LIMIT_MS, ANTIGRAVITY_TOOL_SILENCE_LIMIT_MS, AntigravityCliAdapter } from './antigravity-cli-adapter';
import { isSurfacedToUserError } from './surfaced-error';

const kills = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('./base-cli-process-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./base-cli-process-utils')>()),
  killProcessGroup: (...args: unknown[]) => { kills.calls.push(args); return true; },
}));

const CONVERSATION = 'synthetic-conversation';
const MINUTE = 60_000;

interface FakeAgy {
  child: ChildProcess;
  send(event: Record<string, unknown>): void;
  stderr(text: string): void;
  close(code: number): void;
}

function fakeAgy(adapter: AntigravityCliAdapter): FakeAgy[] {
  const spawned: FakeAgy[] = [];
  vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess')
    .mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        pid: 4242,
        stdin: { end: vi.fn() },
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      }) as unknown as ChildProcess;
      spawned.push({
        child,
        send: event => child.stdout!.emit('data', Buffer.from(`${JSON.stringify(event)}\n`)),
        stderr: text => child.stderr!.emit('data', Buffer.from(text)),
        close: code => child.emit('close', code, null),
      });
      return child;
    });
  return spawned;
}

const init = { event: 'init', conversation_id: CONVERSATION, init: { model: 'Gemini 3.8 Flash (Medium)' } };
function step(update: Record<string, unknown>): Record<string, unknown> {
  return { event: 'step_update', step_update: { conversation_id: CONVERSATION, ...update } };
}
function result(fields: Record<string, unknown>): Record<string, unknown> {
  return { event: 'result', result: { conversation_id: CONVERSATION, ...fields } };
}

function collect(adapter: AntigravityCliAdapter): OutputMessage[] {
  const output: OutputMessage[] = [];
  adapter.on('output', (message: OutputMessage) => output.push(message));
  return output;
}

beforeEach(() => {
  kills.calls.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AntigravityCliAdapter stream-json turns', () => {
  it('shows tool calls, their results and the reply as agy reports them, with agy usage', async () => {
    const adapter = new AntigravityCliAdapter({ model: 'Gemini 3.8 Flash (Medium)' });
    const agy = fakeAgy(adapter);
    const output = collect(adapter);

    const pending = adapter.sendMessage({ role: 'user', content: 'list files' });
    const native = agy[0];
    native.send(init);
    native.send(step({ step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 7000, output_tokens: 100, total_tokens: 7100 } }));
    native.send(step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } }));
    native.send(step({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' }, output: 'a.txt' } }));
    native.send(step({ step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: '/x' } } }));
    native.send(step({ step_index: 3, state: 'ERROR', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', error: { message: 'no such file' } } }));
    native.send(step({ step_index: 4, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Found ' }));
    native.send(step({ step_index: 4, state: 'DONE', step_type: 'agent_response', text_delta: 'a.txt', usage: { input_tokens: 7300, output_tokens: 20, total_tokens: 7320 } }));
    native.send(result({ status: 'SUCCESS', response: 'Found a.txt', usage: { input_tokens: 14300, output_tokens: 120, cache_read_tokens: 4000, total_tokens: 14420 } }));
    native.close(0);
    const response = await pending;

    expect(output.map(message => [message.type, message.content])).toEqual([
      ['tool_use', 'Running command: ls'],
      ['tool_result', 'a.txt'],
      ['tool_use', 'Using tool: read_file'],
      ['tool_result', 'no such file'],
      ['assistant', 'Found '],
      ['assistant', 'a.txt'],
    ]);
    expect(output[0].metadata).toMatchObject({ name: 'run_command', input: { CommandLine: 'ls' }, tool_use_id: `${CONVERSATION}:2` });
    expect(output[1].metadata).toMatchObject({ name: 'run_command', tool_use_id: `${CONVERSATION}:2`, is_error: false });
    expect(output[3].metadata).toMatchObject({ is_error: true });
    expect(output[4].id).toBe(output[5].id);
    expect(output[5].metadata).toMatchObject({ streaming: true, accumulatedContent: 'Found a.txt' });

    expect(response.content).toBe('Found a.txt');
    expect(response.usage).toMatchObject({ inputTokens: 10300, cacheReadTokens: 4000, outputTokens: 120, totalTokens: 14420 });
    expect(response.usage?.isEstimated).toBeUndefined();
    expect(response.metadata).toMatchObject({ conversationId: CONVERSATION, contextTokens: 7320 });
  });

  it('lets a turn that keeps reporting progress run past the silence limit', async () => {
    vi.useFakeTimers();
    const adapter = new AntigravityCliAdapter();
    const agy = fakeAgy(adapter);
    const pending = adapter.sendMessage({ role: 'user', content: 'long triage job' });
    agy[0].send(init);
    for (let index = 1; index <= 6; index++) {
      vi.advanceTimersByTime(ANTIGRAVITY_SILENCE_LIMIT_MS - MINUTE);
      agy[0].send(step({ step_index: index, state: 'DONE', step_type: 'agent_response' }));
    }
    agy[0].send(result({ status: 'SUCCESS', response: 'done' }));
    agy[0].close(0);

    await expect(pending).resolves.toMatchObject({ content: 'done' });
    expect(kills.calls).toEqual([]);
  });

  it('stops a turn that reports nothing for the silence limit, as a turn agy ran', async () => {
    vi.useFakeTimers();
    const adapter = new AntigravityCliAdapter();
    const agy = fakeAgy(adapter);
    const pending = adapter.sendMessage({ role: 'user', content: 'stuck' });
    const settled = pending.catch((error: unknown) => error);
    agy[0].send(init);
    vi.advanceTimersByTime(ANTIGRAVITY_SILENCE_LIMIT_MS - 1);
    expect(kills.calls).toEqual([]);
    vi.advanceTimersByTime(1);

    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Antigravity stopped responding: no progress for 5 minutes');
    expect(isSurfacedToUserError(error)).toBe(true);
    expect(kills.calls).toEqual([[4242, 'SIGTERM']]);
  });

  it('waits longer while a tool runs, because agy is silent until it finishes', async () => {
    vi.useFakeTimers();
    const adapter = new AntigravityCliAdapter();
    const agy = fakeAgy(adapter);
    const pending = adapter.sendMessage({ role: 'user', content: 'run the tests' });
    agy[0].send(init);
    agy[0].send(step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'npm test' } } }));
    vi.advanceTimersByTime(ANTIGRAVITY_TOOL_SILENCE_LIMIT_MS - MINUTE);
    agy[0].send(step({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { output: 'ok' } }));
    agy[0].send(result({ status: 'SUCCESS', response: 'tests pass' }));
    agy[0].close(0);

    await expect(pending).resolves.toMatchObject({ content: 'tests pass' });
    expect(kills.calls).toEqual([]);
  });

  it('stops a tool that stays silent past the longer limit, then uses the short limit again', async () => {
    vi.useFakeTimers();
    const adapter = new AntigravityCliAdapter();
    const agy = fakeAgy(adapter);
    const first = adapter.sendMessage({ role: 'user', content: 'hung tool' }).catch((error: unknown) => error);
    agy[0].send(init);
    agy[0].send(step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command' }));
    vi.advanceTimersByTime(ANTIGRAVITY_TOOL_SILENCE_LIMIT_MS);
    expect(((await first) as Error).message).toBe('Antigravity stopped responding: no progress for 30 minutes');

    const second = adapter.sendMessage({ role: 'user', content: 'quiet model' }).catch((error: unknown) => error);
    agy[1].send(init);
    agy[1].send(step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command' }));
    agy[1].send(step({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command' }));
    vi.advanceTimersByTime(ANTIGRAVITY_SILENCE_LIMIT_MS);
    expect(((await second) as Error).message).toBe('Antigravity stopped responding: no progress for 5 minutes');
  });

  it('still holds a caller to its own time limit', async () => {
    vi.useFakeTimers();
    const adapter = new AntigravityCliAdapter({ timeout: 2 * MINUTE });
    const agy = fakeAgy(adapter);
    const settled = adapter.sendMessage({ role: 'user', content: 'review' }).catch((error: unknown) => error);
    agy[0].send(init);
    vi.advanceTimersByTime(MINUTE);
    agy[0].send(step({ step_index: 1, state: 'DONE', step_type: 'agent_response' }));
    vi.advanceTimersByTime(MINUTE);

    expect(((await settled) as Error).message).toBe('Antigravity CLI timeout after 120 seconds');
    expect(kills.calls).toEqual([[4242, 'SIGTERM']]);
  });

  it('reports a turn once when the user sees it fail, ignoring what agy prints as it is stopped', async () => {
    vi.useFakeTimers();
    const adapter = new AntigravityCliAdapter();
    Object.assign(adapter, { isSpawned: true });
    const agy = fakeAgy(adapter);
    const output = collect(adapter);
    const errors: Error[] = [];
    adapter.on('error', (error: Error) => errors.push(error));

    const settled = adapter.sendInput('stuck').catch((error: unknown) => error);
    await vi.waitFor(() => expect(agy).toHaveLength(1));
    agy[0].send(init);
    vi.advanceTimersByTime(ANTIGRAVITY_SILENCE_LIMIT_MS);
    agy[0].stderr('error: interrupted');
    agy[0].close(1);

    expect(isSurfacedToUserError(await settled)).toBe(true);
    expect(output.filter(message => message.type === 'error').map(message => message.content))
      .toEqual(['Antigravity stopped responding: no progress for 5 minutes']);
    expect(errors.map(error => error.message)).toEqual(['Antigravity stopped responding: no progress for 5 minutes']);
  });

  it('fails with agy\'s own reason when the result reports an error', async () => {
    const adapter = new AntigravityCliAdapter();
    const agy = fakeAgy(adapter);
    const pending = adapter.sendMessage({ role: 'user', content: 'hi' });
    agy[0].send(result({ conversation_id: '', status: 'ERROR', response: '', error: 'invalid model selection' }));
    agy[0].stderr('error: invalid model selection');
    agy[0].close(0);

    const error = await pending.catch((caught: unknown) => caught);
    expect((error as Error).message).toBe('invalid model selection');
    // agy refused the prompt before starting, so it was not delivered.
    expect(isSurfacedToUserError(error)).toBe(false);
  });

  it('uses stderr as the reason when agy exits without a result', async () => {
    const adapter = new AntigravityCliAdapter();
    const agy = fakeAgy(adapter);
    const pending = adapter.sendMessage({ role: 'user', content: 'hi' });
    agy[0].stderr('fatal: language server crashed\n');
    agy[0].close(2);

    await expect(pending).rejects.toThrow('fatal: language server crashed');
  });

  it('shows agy\'s answer when it arrives only in the result', async () => {
    const adapter = new AntigravityCliAdapter();
    const agy = fakeAgy(adapter);
    const output = collect(adapter);
    const pending = adapter.sendMessage({ role: 'user', content: 'hi' });
    agy[0].send(init);
    agy[0].send(result({ status: 'SUCCESS', response: 'Only in the result' }));
    agy[0].close(0);

    await expect(pending).resolves.toMatchObject({ content: 'Only in the result' });
    expect(output.map(message => [message.type, message.content])).toEqual([['assistant', 'Only in the result']]);
  });
});
