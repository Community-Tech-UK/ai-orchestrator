import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('./claude-transcript-registry', () => ({ nativeTranscriptExists: () => true, readLastClaudeCostState: () => undefined }));
import { ClaudeCliAdapter } from './claude-cli-adapter';

function child(pid: number): ChildProcess {
  return Object.assign(new EventEmitter(), { pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), exitCode: null }) as unknown as ChildProcess;
}
function harness() {
  const adapter = new ClaudeCliAdapter({ sessionId: 'test-session', resume: true, residentClaude: true, workingDirectory: '/tmp/aio-continuation-test' });
  const spawn = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
  const emit = (process: ChildProcess, value: unknown) => process.stdout?.emit('data', Buffer.from(JSON.stringify(value) + '\n'));
  return { adapter, spawn, emit };
}
afterEach(() => vi.restoreAllMocks());

describe('Claude loop continuation', () => {
  it('reproduces the separate borrowed-resident lifecycle defect: sendMessage replaces the resident process without stopping it', async () => {
    const { adapter, spawn, emit } = harness();
    const resident = child(10001); const loop = child(10002);
    spawn.mockReturnValueOnce(resident).mockReturnValueOnce(loop);
    await adapter.spawn();
    const response = adapter.sendMessage({ role: 'user', content: 'loop round' });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    emit(loop, { type: 'result', result: 'done' }); loop.emit('close', 0);
    await response;
    expect(resident.kill).not.toHaveBeenCalled();
    expect((adapter as unknown as { process: ChildProcess | null }).process).toBeNull();
  });

  it.each(['test-session', 'different-session'])('records one-shot native resume and confirms only the requested id (%s)', async (sessionId) => {
    const { adapter, spawn, emit } = harness(); const process = child(10003); spawn.mockReturnValue(process);
    const response = adapter.sendMessage({ role: 'user', content: 'continue' });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    expect(adapter.getResumeAttemptResult()).toMatchObject({ source: 'native', confirmed: false, requestedSessionId: 'test-session', forked: false });
    emit(process, { type: 'system', subtype: 'init', session_id: sessionId });
    expect(adapter.getResumeAttemptResult()).toMatchObject({ confirmed: sessionId === 'test-session', actualSessionId: sessionId });
    process.emit('close', 0); await response;
  });

  it('counts compact boundaries for the current one-shot turn only', async () => {
    const { adapter, spawn, emit } = harness();
    const first = child(10004); const second = child(10005); spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const response = adapter.sendMessage({ role: 'user', content: 'first' });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    emit(first, { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } });
    expect(adapter.getTurnCompaction()).toEqual({ count: 1, trigger: 'auto', preTokens: 150000 });
    first.emit('close', 0); await response;
    const next = adapter.sendMessage({ role: 'user', content: 'second' });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(adapter.getTurnCompaction()).toEqual({ count: 0 });
    second.emit('close', 0); await next;
  });
});
