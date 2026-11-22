/**
 * Google retired the Gemini CLI's personal sign-in: the CLI writes one line to stderr and exits with code 1.
 * The turn must end with one error that names the retirement, not the raw line, a second "exited with code 1"
 * line and a "could not be delivered" notice on top.
 */

import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OutputMessage } from '../../../shared/types/instance.types';
import { GeminiCliAdapter } from './gemini-cli-adapter';
import { GeminiClientRetiredError, setGeminiSignInObserver, type GeminiSignInOutcome } from './gemini-client-retired';
import { isSurfacedToUserError } from './surfaced-error';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

/** What gemini 0.70 printed on 21 November 2026 when signed in with a personal Google account. */
const GOOGLE_STDERR = [
  'YOLO mode is enabled. All tool calls will be automatically approved.',
  'An unexpected critical error occurred: This client is no longer supported for Gemini Code Assist for individuals. '
    + 'To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google',
].join('\n');

function fakeProcess(): ChildProcess & { stdout: EventEmitter; stderr: EventEmitter } {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { end: vi.fn() },
    pid: 4321,
  }) as unknown as ChildProcess & { stdout: EventEmitter; stderr: EventEmitter };
}

async function startedAdapter(child: ReturnType<typeof fakeProcess>): Promise<GeminiCliAdapter> {
  const adapter = new GeminiCliAdapter({ timeout: 60_000 });
  vi.spyOn(adapter, 'checkStatus').mockResolvedValue({ available: true, authenticated: true });
  vi.spyOn(adapter as unknown as { spawnProcess: () => ChildProcess }, 'spawnProcess').mockReturnValue(child);
  await adapter.spawn();
  return adapter;
}

function observeOutcomes(): GeminiSignInOutcome[] {
  const outcomes: GeminiSignInOutcome[] = [];
  setGeminiSignInObserver((outcome) => outcomes.push(outcome));
  return outcomes;
}

describe('GeminiCliAdapter when Google has retired the sign-in', () => {
  afterEach(() => setGeminiSignInObserver(undefined));

  it('ends the turn with one retirement error and no raw error lines, and reports the retirement', async () => {
    const outcomes = observeOutcomes();
    const child = fakeProcess();
    const adapter = await startedAdapter(child);
    const outputs: OutputMessage[] = [];
    const errors: Error[] = [];
    adapter.on('output', (message: OutputMessage) => outputs.push(message));
    adapter.on('error', (error: Error) => errors.push(error));

    const sent = adapter.sendInput('Review the plan');
    await vi.waitFor(() => expect(child.stderr.listenerCount('data')).toBeGreaterThan(0));
    child.stderr.emit('data', Buffer.from(GOOGLE_STDERR));
    child.emit('close', 1);

    const failure = await sent.then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(GeminiClientRetiredError);
    // The error event is shown in the transcript, so no "initial message could not be delivered" notice is added.
    expect(isSurfacedToUserError(failure)).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(GeminiClientRetiredError);
    expect(errors[0]?.message).toContain('no longer supported for Gemini Code Assist');
    expect(outputs.filter((message) => message.type === 'error')).toEqual([]);
    expect(outcomes).toEqual(['retired']);
  });

  it('reports a reply when a turn succeeds, which is what ends the record once Gemini is set up another way', async () => {
    const outcomes = observeOutcomes();
    const child = fakeProcess();
    const adapter = await startedAdapter(child);
    adapter.on('error', () => undefined);

    const sent = adapter.sendInput('Review the plan');
    await vi.waitFor(() => expect(child.stdout.listenerCount('data')).toBeGreaterThan(0));
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'message', role: 'assistant', content: 'Looks fine.' })}\n`));
    child.emit('close', 0);
    await sent;

    expect(outcomes).toEqual(['replied']);
  });
});
