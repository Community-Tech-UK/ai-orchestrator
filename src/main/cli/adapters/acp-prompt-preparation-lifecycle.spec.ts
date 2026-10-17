import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { createInitializedAgentHarness, TestAcpCliAdapter } from './acp-cli-adapter.test-helpers';
import { setAcpAttachmentStoreDirForTesting } from './acp-attachment-store';

vi.mock('./base-cli-process-utils', async (original) => ({ ...await original<typeof import('./base-cli-process-utils')>(), killProcessGroup: vi.fn(() => true) }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));

describe('ACP ownership during actual attachment persistence', () => {
  it('does not dispatch retired preparation into a replacement session on the same adapter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aio-acp-preparation-'));
    setAcpAttachmentStoreDirForTesting(dir);
    const oldProcess = createInitializedAgentHarness();
    const replacement = createInitializedAgentHarness();
    replacement.onRequest('session/prompt', (request) => replacement.respond(request.id, { stopReason: 'end_turn' }));
    const adapter = new TestAcpCliAdapter(oldProcess, { workingDirectory: '/tmp', persistImageAttachments: true });
    await adapter.spawn();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const mkdir = fs.promises.mkdir;
    const spy = vi.spyOn(fs.promises, 'mkdir').mockImplementationOnce(async (path, options) => {
      entered(); await held; return mkdir(path, options);
    });
    const sending = adapter.sendMessage({ role: 'user', content: 'retired attachment work', attachments: [{ type: 'image', mimeType: 'image/png', name: 'fixture.png', content: 'dGVzdA==' }] });
    void sending.catch(() => undefined);
    try {
      await started;
      await adapter.terminate(false);
      vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess').mockReturnValue(replacement as unknown as ChildProcess);
      await adapter.spawn();
      release();
      await expect(sending).rejects.toMatchObject({ name: 'AbortError' });
      expect(replacement.receivedMessages.some((message) => 'method' in message && message.method === 'session/prompt')).toBe(false);
    } finally {
      release(); await sending.catch(() => undefined); spy.mockRestore();
      oldProcess.exit(); replacement.exit(); setAcpAttachmentStoreDirForTesting(null);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
