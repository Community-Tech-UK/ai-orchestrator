import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutputMessage } from '../../shared/types/instance.types';
import { readRequestReceipt } from '../../shared/utils/request-receipt-message';

const runtime = vi.hoisted(() => ({ directory: '' }));
vi.mock('electron', () => ({ app: { getPath: () => runtime.directory } }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }));

import { OutputStorageManager } from '../memory/output-storage';
import { outputMessageToContinuityEntry, continuityEntryToOutputMessage } from '../session/continuity-message-projection';
import { UserActionLifecycle } from '../orchestration/user-action-lifecycle';
import { InputRequestReceiptRecorder } from './input-request-receipts';
import { bindInputRequestReceipts } from './input-request-receipt-wiring';

describe('closed-request receipts in durable history', () => {
  let storage: OutputStorageManager;
  let messages: OutputMessage[];
  let recorder: InputRequestReceiptRecorder;
  let manager: EventEmitter;
  let lifecycle: UserActionLifecycle;
  let unbind: () => void;

  beforeEach(async () => {
    runtime.directory = await mkdtemp(join(tmpdir(), 'aio-input-receipt-'));
    storage = new OutputStorageManager();
    messages = [];
    manager = new EventEmitter();
    const orchestration = Object.assign(new EventEmitter(), {
      cancelUserActions: (instanceId: string) => lifecycle.settleForInstance(instanceId, { reason: 'cancelled' }),
      endUserActions: (instanceId: string, reason: 'cancelled' | 'exited') => lifecycle.settleForInstance(instanceId, { reason }),
    });
    recorder = new InputRequestReceiptRecorder({
      isYoloOn: () => false,
      writeReceipt: (instanceId, content, metadata) => {
        const message: OutputMessage = { id: `receipt-${messages.length}`, timestamp: Date.now(), type: 'system', content, metadata: { ...metadata } };
        messages.push(message);
        void storage.storeMessages(instanceId, [message]);
      },
    });
    unbind = bindInputRequestReceipts(manager, recorder, orchestration);
    lifecycle = new UserActionLifecycle(settled => orchestration.emit('user-action-resolved', settled));
  });

  afterEach(async () => {
    lifecycle.dispose();
    unbind();
    await storage.flushInstance('session');
    await rm(runtime.directory, { recursive: true, force: true });
  });

  async function reload(): Promise<OutputMessage[]> {
    await storage.flushInstance('session');
    // A new storage object reads the actual gzip/index files, then the normal continuity replay projection.
    const restored = await new OutputStorageManager().loadMessages('session');
    return restored.map(message => continuityEntryToOutputMessage(JSON.parse(JSON.stringify(outputMessageToContinuityEntry(message)))));
  }

  it('persists one native answer despite decided-before-ack and later duplicate close events', async () => {
    manager.emit('instance:input-required', { instanceId: 'session', requestId: 'native-1', timestamp: 1,
      metadata: { type: 'ask_user_question' } });
    const sending = recorder.beginReply('session', 'native-1');
    manager.emit('instance:input-required-resolved', { instanceId: 'session', requestId: 'native-1', reason: 'decided' });
    expect(messages).toEqual([]);
    sending.commit({ response: 'a'.repeat(90) });
    manager.emit('instance:input-required-resolved', { instanceId: 'session', requestId: 'native-1', reason: 'exited' });
    const restored = await reload();
    expect(restored).toHaveLength(1);
    expect(readRequestReceipt(restored[0])).toEqual({ requestId: 'native-1', text: `You answered: ${'a'.repeat(60)}…`, outcome: 'answered', requestedAt: 1 });
    expect(restored[0].metadata?.['audience']).toBe('attention');
    expect(await storage.getUserPrompts('session')).toEqual([]);
  });

  it.each(['timeout', 'cancelled', 'exited'] as const)('persists an orchestrator %s and its one resolution over the existing event', async reason => {
    const closed = vi.fn();
    manager.on('instance:input-required-resolved', closed);
    lifecycle.open({ id: 'engine-1', instanceId: 'session', requestType: 'ask_questions', questions: ['Which?'], title: 'Question', message: 'Which?', createdAt: 1 });
    lifecycle.settle('engine-1', { reason });
    expect(lifecycle.settle('engine-1', { reason })).toBeNull();
    const restored = await reload();
    expect(restored).toHaveLength(1);
    expect(readRequestReceipt(restored[0])).toMatchObject({ requestId: 'engine-1', outcome: reason, requestedAt: 1 });
    expect(closed).toHaveBeenCalledExactlyOnceWith({ instanceId: 'session', requestId: 'engine-1', reason, kind: 'user-action' });
    expect(await storage.getUserPrompts('session')).toEqual([]);
  });

  it('closes an engine card through the real binder when its provider exits without removal', async () => {
    lifecycle.open({ id: 'engine-exit', instanceId: 'session', requestType: 'confirm', title: 'Proceed?', message: 'Run it?', createdAt: 1 }, { timeoutMs: 60_000 });
    manager.emit('instance:state-changed', { instanceId: 'session', status: 'failed' });
    expect(lifecycle.list()).toEqual([]);
    expect(lifecycle.settle('engine-exit', { reason: 'decided', approved: true, via: 'window' })).toBeNull();
    const restored = await reload();
    expect(restored.map(row => readRequestReceipt(row)?.outcome)).toEqual(['exited']);
    expect(restored.map(row => row.content)).toEqual(['Cancelled when the session closed']);
  });

  it('persists only the label of a saved secret and never the reference or any value', async () => {
    lifecycle.open({ id: 'secret-1', instanceId: 'session', requestType: 'secret_required', title: 'Secret needed', message: 'Save it', createdAt: 1,
      secretRequest: { name: 'token', label: 'Deployment token', purpose: 'Deploy' } });
    lifecycle.settle('secret-1', { reason: 'decided', approved: true, selectedOption: 'secret://token', via: 'window' });
    const restored = await reload();
    expect(restored.map(message => message.content)).toEqual(['You saved: Deployment token']);
    expect(JSON.stringify(restored)).not.toContain('secret://');
    expect(await storage.getUserPrompts('session')).toEqual([]);
  });
});
