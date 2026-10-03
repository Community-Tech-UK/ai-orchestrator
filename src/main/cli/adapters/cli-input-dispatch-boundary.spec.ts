import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { GeminiCliAdapter } from './gemini-cli-adapter';
import { AntigravityCliAdapter } from './antigravity-cli-adapter';
import { CursorCliAdapter } from './cursor-cli-adapter';
import { CopilotCliAdapter } from './copilot-cli-adapter';
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('./copilot/copilot-account-home-resolver', () => ({ resolveCopilotProfileHome: () => '/disposable-copilot-home' }));
describe.each(['gemini', 'antigravity', 'cursor', 'copilot'] as const)('%s native argv dispatch', name => {
  it.each(['busy-stop', 'admission-stop', 'written-stop', 'new-owner', 'success'] as const)('keeps admission and completion truthful for %s', async mode => {
    const adapter = name === 'gemini' ? new GeminiCliAdapter() : name === 'antigravity' ? new AntigravityCliAdapter() : name === 'cursor' ? new CursorCliAdapter() : new CopilotCliAdapter({ accountProfileId: 'disposable-profile' });
    Object.assign(adapter, { isSpawned: true });
    const controller = new AbortController(); let eligible = true; const nativeArgs: string[][] = []; const complete = vi.fn(); const admission = vi.fn(() => { if (mode === 'admission-stop') controller.abort(); });
    adapter.on('complete', complete); adapter.on('error', () => undefined);
    adapter.on('status', status => { if (status === 'busy') { if (mode === 'busy-stop') controller.abort(); if (mode === 'new-owner') eligible = false; } });
    (adapter as unknown as { spawnProcess: (args: string[]) => ChildProcess }).spawnProcess = args => {
      nativeArgs.push(args); const child = new EventEmitter() as unknown as ChildProcess;
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      queueMicrotask(() => { if (mode === 'written-stop') controller.abort(); child.emit('close', 0, null); }); return child;
    };
    const pending = adapter.sendInput('synthetic continuation', undefined, { dispatch: {
      signal: controller.signal, autoContinuation: true, beforeProviderDispatch: admission,
      assertCurrent: () => { if (!eligible) { const error = new Error('owner changed'); error.name = 'AbortError'; throw error; } },
    } });
    if (mode === 'success') await pending; else await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const written = mode === 'success' || mode === 'written-stop';
    expect(nativeArgs).toHaveLength(written ? 1 : 0);
    if (written) expect(nativeArgs[0]).toContain('synthetic continuation');
    expect(admission).toHaveBeenCalledTimes(mode === 'busy-stop' || mode === 'new-owner' ? 0 : 1);
    expect(complete).toHaveBeenCalledTimes(mode === 'success' ? 1 : 0);
  });
});
