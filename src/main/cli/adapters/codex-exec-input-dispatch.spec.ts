import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { CodexCliAdapter } from './codex-cli-adapter';
vi.mock('./codex/app-server-client', async (original) => ({ ...await original<object>(), terminateProcessTree: vi.fn() }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
it('cancels an empty-output exec retry during its backoff without another native write', async () => {
  const adapter = new CodexCliAdapter({ timeout: 2000 }); Object.assign(adapter, { useAppServer: false, isSpawned: true });
  const controller = new AbortController(); const admission = vi.fn(); const complete = vi.fn(); const writes: string[] = [];
  const spawn = vi.fn(() => {
    const child = new EventEmitter() as unknown as ChildProcess; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.stdin.on('data', (chunk: Buffer) => writes.push(chunk.toString()));
    child.stdin.once('finish', () => { child.emit('close', 0, null); setTimeout(() => controller.abort(), 0); }); return child;
  });
  (adapter as unknown as { spawnProcess: () => ChildProcess }).spawnProcess = spawn; adapter.on('complete', complete);
  await expect(adapter.sendInput('synthetic continuation', undefined, { dispatch: {
    signal: controller.signal, autoContinuation: true, beforeProviderDispatch: admission,
  } })).rejects.toMatchObject({ name: 'AbortError' });
  expect(spawn).toHaveBeenCalledOnce(); expect(writes).toHaveLength(1); expect(admission).toHaveBeenCalledOnce(); expect(complete).not.toHaveBeenCalled();
});
