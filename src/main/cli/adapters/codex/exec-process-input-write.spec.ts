import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { runCodexExecProcess } from './exec-process-runner';
it('releases exact buffered native stdout and stderr once the actual Writable callback accepts input', async () => {
  let release!: (error?: Error | null) => void;
  const stdin = new Writable({ write(_chunk, _encoding, callback) { release = callback; } });
  const child = Object.assign(new EventEmitter(), { stdin, stdout: new PassThrough(), stderr: new PassThrough(), pid: 123456789, killed: false, exitCode: null, signalCode: null }) as unknown as ChildProcess;
  let active: ChildProcess | null = null;
  const output = vi.fn();
  const pending = runCodexExecProcess({ spawn: () => child, setProcess: process => active = process, isActiveProcess: process => active === process, message: { role: 'user', content: 'LOCAL_PROMPT' }, phase: 'startup', timeoutMs: 1000, deadlineMs: 1000, turnIdleTimeoutMs: 1000, emitOutput: output, emitExit: vi.fn(), emitHeartbeat: vi.fn(), onThreadId: vi.fn(), generateResponseId: () => 'LOCAL_RESPONSE' });
  child.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'item.created', item: { type: 'command_execution', command: 'LOCAL_COMMAND' } }) + '\n'));
  child.stderr!.emit('data', Buffer.from('WARN LOCAL_NATIVE_DIAGNOSTIC\n'));
  expect(output).not.toHaveBeenCalled();
  release();
  await new Promise(resolve => setImmediate(resolve));
  try {
    expect(output.mock.calls.map(([message]) => message.content)).toEqual(['Running command: LOCAL_COMMAND', '[codex] WARN LOCAL_NATIVE_DIAGNOSTIC']);
  }
  finally {
    (child as unknown as {
      exitCode: number;
    }).exitCode = 0;
    child.emit('close', 0, null);
    await pending;
    expect(stdin.listenerCount('error')).toBe(0);
    expect(stdin.listenerCount('close')).toBe(0);
    expect(active).toBeNull();
  }
});
