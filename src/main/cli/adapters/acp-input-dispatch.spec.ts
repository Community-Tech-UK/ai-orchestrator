import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'stream';
import type { AdapterInputDispatch } from './base-cli-adapter.types';
import type { AcpJsonRpcRequest } from '../../../shared/types/cli.types';
import { createInitializedAgentHarness, TestAcpCliAdapter, type FakeAcpProcess } from './acp-cli-adapter.test-helpers';
import { setAcpAttachmentStoreDirForTesting } from './acp-attachment-store';

vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));

function prompts(proc: FakeAcpProcess): AcpJsonRpcRequest[] {
  return proc.receivedMessages.filter((message): message is AcpJsonRpcRequest => 'method' in message && 'id' in message && message.method === 'session/prompt');
}

function fixture(extra: Partial<ConstructorParameters<typeof TestAcpCliAdapter>[1]> = {}) {
  const proc = createInitializedAgentHarness();
  proc.onRequest('session/prompt', (message) => proc.respond(message.id, { stopReason: 'end_turn' }));
  const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', requestTimeoutMs: 1000, ...extra });
  return { proc, adapter };
}

describe('ACP final native input dispatch', () => {
  it.each(['stop', 'manual-input'] as const)('does not write after %s revokes ownership in a busy observer', async () => {
    const { proc, adapter } = fixture();
    const controller = new AbortController();
    const admit = vi.fn();
    const errors: Error[] = [];
    adapter.on('error', (error) => errors.push(error));
    await adapter.spawn();
    adapter.once('status', (status) => { if (status === 'busy') controller.abort(); });
    try {
      await expect(adapter.sendInput('synthetic continuation', undefined, { dispatch: { signal: controller.signal, beforeProviderDispatch: admit } })).rejects.toMatchObject({ name: 'AbortError' });
      expect(prompts(proc)).toEqual([]);
      expect(admit).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
      await adapter.sendInput('new manual request');
      expect(prompts(proc)).toHaveLength(1);
      expect(JSON.stringify(prompts(proc))).toContain('new manual request');
    } finally { proc.exit(); }
  });

  it('rechecks current ownership after a synchronous admission observer', async () => {
    const { proc, adapter } = fixture();
    let eligible = true;
    const dispatch: AdapterInputDispatch = {
      assertCurrent: () => { if (!eligible) throw Object.assign(new Error('Synthetic newer request'), { name: 'AbortError' }); },
      beforeProviderDispatch: () => { eligible = false; },
    };
    try {
      await adapter.spawn();
      await expect(adapter.sendInput('synthetic continuation', undefined, { dispatch })).rejects.toMatchObject({ name: 'AbortError' });
      expect(prompts(proc)).toEqual([]);
      await adapter.sendInput('valid subsequent request');
      expect(prompts(proc)).toHaveLength(1);
    } finally { proc.exit(); }
  });

  it('rechecks cancellation after spawn initialization before admission', async () => {
    const controller = new AbortController();
    const { proc, adapter } = fixture({ prepareSpawn: async () => { controller.abort(); return () => undefined; } });
    const admit = vi.fn();
    try {
      await expect(adapter.sendInput('synthetic continuation', undefined, { dispatch: { signal: controller.signal, beforeProviderDispatch: admit } })).rejects.toMatchObject({ name: 'AbortError' });
      expect(proc.receivedMessages.some((message) => 'method' in message && message.method === 'initialize')).toBe(true);
      expect(prompts(proc)).toEqual([]);
      expect(admit).not.toHaveBeenCalled();
    } finally { proc.exit(); }
  });

  it('commits once after busy and before the native write, without serializing controls', async () => {
    const { proc, adapter } = fixture();
    const order: string[] = [];
    const dispatch: AdapterInputDispatch = { signal: new AbortController().signal, autoContinuation: true,
      beforeProviderDispatch: () => order.push('admitted'), assertCurrent: () => undefined };
    proc.onRequest('session/prompt', (message) => { order.push('native-write'); proc.respond(message.id, { stopReason: 'end_turn' }); });
    try {
      await adapter.spawn();
      adapter.on('status', (status) => { if (status === 'busy') order.push('busy'); });
      await adapter.sendInput('valid continuation', undefined, { dispatch });
      expect(order).toEqual(['busy', 'admitted', 'native-write']);
      expect(prompts(proc)).toHaveLength(1);
      expect(prompts(proc)[0]?.params).toEqual({ sessionId: 'sess-acp-1', prompt: [{ type: 'text', text: 'valid continuation' }] });
    } finally { proc.exit(); }
  });

  it('rechecks cancellation after actual asynchronous attachment persistence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aio-acp-dispatch-'));
    setAcpAttachmentStoreDirForTesting(dir);
    const { proc, adapter } = fixture({ persistImageAttachments: true });
    const controller = new AbortController();
    const admit = vi.fn();
    try {
      await adapter.spawn();
      const pending = adapter.sendInput('synthetic continuation', [{ name: 'synthetic.png', type: 'image/png', size: 4, data: 'dGVzdA==' }],
        { dispatch: { signal: controller.signal, beforeProviderDispatch: admit } });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(prompts(proc)).toEqual([]);
      expect(admit).not.toHaveBeenCalled();
    } finally { proc.exit(); setAcpAttachmentStoreDirForTesting(null); await rm(dir, { recursive: true, force: true }); }
  });

  it('keeps first-turn instructions available after cancelling an unwritten prompt', async () => {
    const { proc, adapter } = fixture({ systemPrompt: 'Synthetic system instruction', rtkEnabled: true });
    const controller = new AbortController();
    try {
      await adapter.spawn();
      adapter.once('status', (status) => { if (status === 'busy') controller.abort(); });
      await expect(adapter.sendInput('cancelled continuation', undefined, { dispatch: { signal: controller.signal } })).rejects.toMatchObject({ name: 'AbortError' });
      await adapter.sendInput('real first request');
      const wire = JSON.stringify(prompts(proc));
      expect(prompts(proc)).toHaveLength(1);
      expect(wire).toContain('Synthetic system instruction');
      expect(wire).toContain('[RTK AWARENESS]');
      expect(wire).not.toContain('cancelled continuation');
    } finally { proc.exit(); }
  });

  it('keeps first-turn instructions available after an actual native write rejection', async () => {
    const { proc, adapter } = fixture({ systemPrompt: 'Synthetic system instruction', rtkEnabled: true });
    adapter.on('error', () => undefined);
    await adapter.spawn();
    const write = proc.stdin.write;
    const failure = new Error('synthetic native pipe rejection');
    proc.stdin.write = () => { throw failure; };
    try {
      await expect(adapter.sendInput('unwritten request')).rejects.toBe(failure);
      expect(prompts(proc)).toEqual([]);
      proc.stdin.write = write;
      await adapter.sendInput('real first request');
      expect(prompts(proc)).toHaveLength(1);
      const wire = JSON.stringify(prompts(proc));
      expect(wire).toContain('Synthetic system instruction');
      expect(wire).toContain('[RTK AWARENESS]');
      expect(wire).not.toContain('unwritten request');
    } finally { proc.exit(); }
  });

  it.each([1, 16384])('restores first-turn instructions after asynchronous native rejection at highWaterMark %s', async (highWaterMark) => {
    const { proc, adapter } = fixture({ systemPrompt: 'Synthetic system instruction', rtkEnabled: true });
    adapter.on('error', () => undefined);
    await adapter.spawn();
    const original = proc.stdin;
    const failure = Object.assign(new Error('synthetic async rejected input'), { code: 'EPIPE' });
    const stdin = new Writable({ highWaterMark, write(_chunk, _encoding, callback) { queueMicrotask(() => callback(failure)); } });
    (proc as unknown as { stdin: Writable }).stdin = stdin;
    try {
      await expect(adapter.sendInput('unaccepted automatic input')).rejects.toBe(failure);
      expect(prompts(proc)).toEqual([]);
      (proc as unknown as { stdin: Writable }).stdin = original;
      await adapter.sendInput('new first request');
      expect(prompts(proc)).toHaveLength(1);
      const wire = JSON.stringify(prompts(proc));
      expect(wire).toContain('Synthetic system instruction');
      expect(wire).toContain('[RTK AWARENESS]');
      expect(wire).not.toContain('unaccepted automatic input');
    } finally { proc.exit(); }
  });
});
