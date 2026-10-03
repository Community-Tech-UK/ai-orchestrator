import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { runCodexExecProcess } from './codex/exec-process-runner';
import { CodexCliAdapter } from './codex-cli-adapter';
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('./base-cli-process-utils', async (original) => ({ ...await original<object>(), killProcessGroup: vi.fn(() => true) }));
vi.mock('./codex/app-server-client', async (original) => ({ ...await original<object>(), terminateProcessTree: vi.fn() }));
afterEach(() => vi.useRealTimers());
const answer = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'LOCAL_PRIOR_ANSWER' } }) + '\n';
const thread = JSON.stringify({ type: 'thread.started', thread_id: 'LOCAL_UNACCEPTED_THREAD' }) + '\n';
function fixture(held = false) {
  let release!: (error?: Error | null) => void;
  const writes: string[] = [];
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(chunk.toString()); release = callback; if (!held)
        callback();
    }
  });
  stdin.on('error', () => { /* Observe native Writable failures without replacing the awaiting owner. */ });
  const child = Object.assign(new EventEmitter(), { stdin, stdout: new PassThrough(), stderr: new PassThrough(), pid: 123456789, killed: false, exitCode: null, signalCode: null }) as unknown as ChildProcess;
  const close = (code = 0) => {
    (child as unknown as {
      exitCode: number;
    }).exitCode = code; child.emit('close', code, null);
  };
  return { child, writes, release: (error?: Error) => release(error), close };
}
function run(proc: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  let active: ChildProcess | null = null;
  const emitOutput = vi.fn();
  const emitExit = vi.fn();
  const onThreadId = vi.fn();
  const admission = vi.fn();
  const promise = runCodexExecProcess({ spawn: () => proc.child, setProcess: proc => { active = proc; }, isActiveProcess: proc => proc === active, message: { role: 'user', content: 'LOCAL_PROMPT' }, phase: 'startup', timeoutMs: 1000, deadlineMs: 1000, turnIdleTimeoutMs: 1000, emitOutput, emitExit, emitHeartbeat: vi.fn(), onThreadId, generateResponseId: () => 'LOCAL_RESPONSE', dispatch: { beforeProviderDispatch: admission }, ...overrides });
  const outcome = promise.then(value => ({ status: 'fulfilled' as const, value }), error => ({ status: 'rejected' as const, error }));
  return { outcome, emitOutput, emitExit, onThreadId, admission, active: () => active };
}
it.each(['EPIPE', 'EIO'])('rejects exact callback %s after natural zero close, no prior completion/thread/tool output', async (code) => {
  const proc = fixture(true);
  const nativeError = Object.assign(new Error('LOCAL_NATIVE_WRITE_FAILURE'), { code });
  const turn = run(proc);
  proc.release(nativeError);
  await new Promise(resolve => setImmediate(resolve));
  proc.child.stdout!.emit('data', Buffer.from(thread + JSON.stringify({ type: 'item.created', item: { type: 'command_execution', command: 'LOCAL_PRIOR_COMMAND' } }) + '\n' + answer));
  proc.close();
  const result = await turn.outcome;
  expect(proc.child.exitCode).toBe(0);
  expect(proc.writes).toEqual(['LOCAL_PROMPT']);
  expect(turn.admission).toHaveBeenCalledOnce();
  expect(turn.emitExit).toHaveBeenCalledOnce();
  expect(result.status).toBe('rejected');
  if (result.status === 'rejected')
    expect(result.error).toBe(nativeError);
  expect(turn.onThreadId).not.toHaveBeenCalled();
  expect(turn.emitOutput).not.toHaveBeenCalled();
  expect(turn.active()).toBeNull();
  await new Promise(resolve => setImmediate(resolve));
  expect(proc.child.stdin!.listenerCount('error')).toBe(1); // Only the fixture's native observer remains.
  expect(proc.child.stdin!.listenerCount('close')).toBe(0);
});
it.each(['idle', 'deadline'])('retains native failure through %s watchdog, even when partial output was buffered', async (kind) => {
  const proc = fixture(true);
  const nativeError = Object.assign(new Error('LOCAL_NATIVE_FAILURE_BEFORE_TIMEOUT'), { code: 'EIO' });
  const turn = run(proc, { timeoutMs: kind === 'idle' ? 25 : 500, deadlineMs: kind === 'deadline' ? 25 : 500, turnIdleTimeoutMs: kind === 'idle' ? 25 : 500, message: { role: 'user', content: 'LOCAL_PROMPT', metadata: { allowPartialOnTimeout: true } } });
  proc.child.stdout!.emit('data', Buffer.from(thread + answer));
  proc.release(nativeError);
  const result = await turn.outcome;
  expect(result.status).toBe('rejected');
  if (result.status === 'rejected')
    expect(result.error).toBe(nativeError);
  expect(turn.onThreadId).not.toHaveBeenCalled();
  expect(turn.active()).toBeNull();
  await new Promise(resolve => setImmediate(resolve));
  expect(proc.child.stdin!.listenerCount('error')).toBe(1); // Only the fixture's native observer remains.
  expect(proc.child.stdin!.listenerCount('close')).toBe(0);
});
it.each(['signal', 'manual', 'generation', 'goal'])('keeps %s takeover authoritative over held write failure and no retry', async (owner) => {
  const proc = fixture(true);
  const adapter = new CodexCliAdapter({ timeout: 1000, rtkEnabled: true });
  Object.assign(adapter, { useAppServer: false, isSpawned: true });
  const spawn = vi.spyOn(adapter as unknown as {
    spawnProcess(args: string[]): ChildProcess;
  }, 'spawnProcess').mockReturnValue(proc.child);
  const controller = new AbortController();
  let current = true;
  const statuses: string[] = [];
  const outputs = vi.fn();
  const completed = vi.fn();
  const turnError = vi.fn();
  adapter.on('status', status => statuses.push(status));
  adapter.on('output', outputs);
  adapter.on('complete', completed);
  adapter.on('turn_error', turnError);
  const admission = vi.fn();
  const pending = adapter.sendInput('LOCAL_PROMPT', undefined, {
    dispatch: {
      signal: controller.signal, autoContinuation: true, beforeProviderDispatch: admission, assertCurrent: () => {
        if (!current)
          throw Object.assign(new Error('LOCAL_TAKEOVER'), { name: 'AbortError' });
      }
    }
  }).then(() => ({ status: 'fulfilled' as const }), error => ({ status: 'rejected' as const, error }));
  await vi.waitFor(() => expect(proc.writes).toHaveLength(1));
  if (owner === 'signal')
    controller.abort();
  else
    current = false;
  proc.release(Object.assign(new Error('LOCAL_LATE_NATIVE_FAILURE'), { code: 'EIO' }));
  proc.close();
  const result = await pending;
  expect(result.status).toBe('rejected');
  if (result.status === 'rejected')
    expect(result.error.name).toBe('AbortError');
  expect(spawn).toHaveBeenCalledOnce();
  expect(admission).toHaveBeenCalledOnce();
  expect(completed).not.toHaveBeenCalled();
  expect(turnError).not.toHaveBeenCalled();
  expect(outputs).not.toHaveBeenCalled();
  expect(statuses).not.toContain('error');
});
it('ordinary accepted interrupt suppresses unaccepted late native failure side effects without caller controls', async () => {
  const proc = fixture(true);
  const adapter = new CodexCliAdapter({ timeout: 1000 });
  Object.assign(adapter, { useAppServer: false, isSpawned: true });
  const spawn = vi.spyOn(adapter as unknown as {
    spawnProcess(args: string[]): ChildProcess;
  }, 'spawnProcess').mockReturnValue(proc.child);
  const outputs = vi.fn();
  const completed = vi.fn();
  const turnError = vi.fn();
  const statuses: string[] = [];
  adapter.on('output', outputs);
  adapter.on('complete', completed);
  adapter.on('turn_error', turnError);
  adapter.on('status', status => statuses.push(status));
  const pending = adapter.sendInput('LOCAL_ORDINARY_PROMPT').then(() => ({ status: 'fulfilled' as const }), error => ({ status: 'rejected' as const, error }));
  await vi.waitFor(() => expect(proc.writes).toHaveLength(1));
  expect(adapter.interrupt().status).toBe('accepted');
  proc.release(Object.assign(new Error('LOCAL_STOPPED_NATIVE_FAILURE'), { code: 'EIO' }));
  proc.child.stdout!.emit('data', Buffer.from(answer));
  proc.close();
  const result = await pending;
  expect(result.status).toBe('rejected');
  if (result.status === 'rejected')
    expect(result.error.name).toBe('AbortError');
  expect(spawn).toHaveBeenCalledOnce();
  expect(completed).not.toHaveBeenCalled();
  expect(turnError).not.toHaveBeenCalled();
  expect(outputs).not.toHaveBeenCalled();
  expect(statuses).toEqual(['busy']);
});
it('restores first-turn awareness after unaccepted model-like write error without model fallback or cancellation leakage', async () => {
  const adapter = new CodexCliAdapter({ timeout: 1000, rtkEnabled: true, model: 'LOCAL_MODEL' });
  Object.assign(adapter, { useAppServer: false, isSpawned: true });
  const first = fixture(true);
  const next = fixture(true);
  const spawn = vi.spyOn(adapter as unknown as {
    spawnProcess(args: string[]): ChildProcess;
  }, 'spawnProcess').mockReturnValueOnce(first.child).mockReturnValueOnce(next.child);
  const flags = adapter as unknown as {
    rtkAwarenessSent: boolean;
    execModelArgSuppressed: boolean;
    hasCompletedExecTurn: boolean;
    conversationHistory: unknown[];
  };
  const originalSession = adapter.getSessionId();
  const nativeError = Object.assign(new Error('unknown model LOCAL_NATIVE_WRITE_FAILURE'), { code: 'EIO' });
  const pending = adapter.sendMessage({ role: 'user', content: 'LOCAL_FIRST' });
  await vi.waitFor(() => expect(first.writes).toHaveLength(1));
  first.release(nativeError);
  await new Promise(resolve => setImmediate(resolve));
  first.close();
  await expect(pending).rejects.toBe(nativeError);
  expect(flags.rtkAwarenessSent).toBe(false);
  expect(flags.execModelArgSuppressed).toBe(false);
  expect(flags.hasCompletedExecTurn).toBe(false);
  expect(flags.conversationHistory).toEqual([]);
  expect(adapter.getSessionId()).toBe(originalSession);
  const following = adapter.sendMessage({ role: 'user', content: 'LOCAL_NEXT' });
  await vi.waitFor(() => expect(next.writes).toHaveLength(1));
  expect(next.writes[0]).toContain('rtk');
  expect(next.writes[0]).toContain('LOCAL_NEXT');
  next.release();
  await new Promise(resolve => setImmediate(resolve));
  next.child.stdout!.emit('data', Buffer.from(answer));
  next.close();
  expect((await following).content).toBe('LOCAL_PRIOR_ANSWER');
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(flags.rtkAwarenessSent).toBe(true);
});
it('ordinary Stop intent stays with its original attempt and later EIO retains its error owner', async () => {
  const first = fixture(true);
  const next = fixture(true);
  const adapter = new CodexCliAdapter({ timeout: 1000 });
  Object.assign(adapter, { useAppServer: false, isSpawned: true });
  const spawn = vi.spyOn(adapter as unknown as {
    spawnProcess(args: string[]): ChildProcess;
  }, 'spawnProcess').mockReturnValueOnce(first.child).mockReturnValueOnce(next.child);
  const errors = vi.fn();
  const complete = vi.fn();
  adapter.on('turn_error', errors);
  adapter.on('complete', complete);
  const stopped = adapter.sendInput('LOCAL_STOPPED');
  const observed = expect(stopped).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(first.writes).toHaveLength(1));
  expect(adapter.interrupt().status).toBe('accepted');
  first.release(Object.assign(new Error('LOCAL_STOPPED_EIO'), { code: 'EIO' }));
  await new Promise(resolve => setImmediate(resolve));
  first.close();
  await observed;
  expect(errors).not.toHaveBeenCalled();
  const nativeError = Object.assign(new Error('LOCAL_FOLLOWING_EIO'), { code: 'EIO' });
  const following = adapter.sendInput('LOCAL_FOLLOWING');
  const failed = expect(following).rejects.toBe(nativeError);
  await vi.waitFor(() => expect(next.writes).toHaveLength(1));
  next.release(nativeError);
  await new Promise(resolve => setImmediate(resolve));
  next.close();
  await failed;
  expect(errors).toHaveBeenCalledOnce();
  expect(errors.mock.calls[0][0]).toBe(nativeError);
  expect(complete).not.toHaveBeenCalled();
  expect(spawn).toHaveBeenCalledTimes(2);
});
