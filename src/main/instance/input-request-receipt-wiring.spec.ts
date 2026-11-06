import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import type { UserActionRequest } from '../orchestration/orchestration-handler.types';
import type { SettledUserAction } from '../orchestration/user-action-lifecycle';
import { bindInputRequestReceipts, type ReceiptWiringOrchestration } from './input-request-receipt-wiring';
import { InputRequestReceiptRecorder } from './input-request-receipts';

class FakeOrchestration extends EventEmitter implements ReceiptWiringOrchestration {
  readonly endUserActions = vi.fn((_instanceId: string, _reason: 'cancelled' | 'exited') => 0);
  readonly cancelUserActions = vi.fn((_instanceId: string) => 0);
}

describe('bindInputRequestReceipts', () => {
  let manager: EventEmitter;
  let orchestration: FakeOrchestration;
  let lines: string[];
  let resolvedForWindows: Record<string, unknown>[];
  let unbind: () => void;

  beforeEach(() => {
    manager = new EventEmitter();
    orchestration = new FakeOrchestration();
    lines = [];
    resolvedForWindows = [];
    const recorder = new InputRequestReceiptRecorder({
      writeReceipt: (_instanceId, content) => lines.push(content),
      isYoloOn: () => false,
    });
    // What the window and the phone listen to; the binder must not feed its own announcements back to itself.
    manager.on('instance:input-required-resolved', (payload: Record<string, unknown>) => resolvedForWindows.push(payload));
    unbind = bindInputRequestReceipts(manager, recorder, orchestration);
  });

  const askToRun = (requestId = 'perm-1', instanceId = 'i-1') => manager.emit('instance:input-required', {
    instanceId, requestId, prompt: 'Run it?', timestamp: Date.now(), metadata: { type: 'deferred_permission', tool_name: 'Bash' },
  });

  const card = (overrides: Partial<UserActionRequest> = {}): UserActionRequest => ({
    id: 'uar-1', instanceId: 'i-1', requestType: 'confirm', title: 'Proceed?', message: 'Run it?', createdAt: 1, ...overrides,
  });

  describe('a request from a CLI', () => {
    it('leaves a line when an adapter says it timed out', () => {
      askToRun();

      manager.emit('instance:input-required-resolved', { instanceId: 'i-1', requestId: 'perm-1', reason: 'timeout' });

      expect(lines).toEqual(['No answer in time; nothing ran']);
    });

    it('ignores a reason it does not know rather than guessing one', () => {
      askToRun();

      manager.emit('instance:input-required-resolved', { instanceId: 'i-1', requestId: 'perm-1', reason: 'something-new' });

      expect(lines).toEqual([]);
    });

    it('leaves a line when the turn is being stopped, and when the session ends', () => {
      askToRun('perm-1');
      askToRun('perm-2');

      manager.emit('instance:state-changed', { instanceId: 'i-1', status: 'busy' });
      expect(lines).toEqual([]);
      manager.emit('instance:state-changed', { instanceId: 'i-1', status: 'interrupting' });

      expect(lines).toEqual(['Cancelled when the session was stopped', 'Cancelled when the session was stopped']);
    });

    it('forgets a session that was removed', () => {
      askToRun();

      manager.emit('instance:removed', 'i-1');
      manager.emit('instance:input-required-resolved', { instanceId: 'i-1', requestId: 'perm-1', reason: 'timeout' });

      expect(lines).toEqual([]);
    });

    it('says approvals were allowed automatically once YOLO is on, and ignores a toggle that only queued', () => {
      askToRun();

      manager.emit('instance:yolo-toggled', { instanceId: 'i-1', yoloMode: false, pendingYoloMode: true });
      expect(lines).toEqual([]);
      manager.emit('instance:yolo-toggled', { instanceId: 'i-1', yoloMode: true });

      expect(lines).toEqual(['Allowed automatically']);
    });
  });

  describe('a card the model raised', () => {
    it('leaves a line and tells the windows and the phone it is closed, marked as one of the model\'s own', () => {
      const settled: SettledUserAction = {
        request: card(), waitedMs: 300_000, end: { reason: 'timeout' },
      };

      orchestration.emit('user-action-resolved', settled);

      expect(lines).toEqual(['No answer in 5 minutes; nothing ran']);
      expect(resolvedForWindows).toEqual([{ instanceId: 'i-1', requestId: 'uar-1', reason: 'timeout', kind: 'user-action' }]);
    });

    it('reports an answer as decided, and does not word it twice', () => {
      orchestration.emit('user-action-resolved', {
        request: card(), waitedMs: 10, end: { reason: 'decided', approved: true, via: 'window' },
      } satisfies SettledUserAction);

      expect(lines).toEqual(['You approved: Proceed?']);
      expect(resolvedForWindows.map((payload) => payload['reason'])).toEqual(['decided']);
    });
  });

  describe('stopping a turn', () => {
    it('cancels every question and approval that turn was waiting on', () => {
      manager.emit('instance:interrupt-requested', { instanceId: 'i-9', origin: 'renderer-ipc' });

      expect(orchestration.cancelUserActions).toHaveBeenCalledWith('i-9');
    });
  });

  describe('unbinding', () => {
    it('removes every listener it added', () => {
      unbind();

      expect(manager.listenerCount('instance:input-required')).toBe(0);
      expect(manager.listenerCount('instance:state-changed')).toBe(0);
      expect(manager.listenerCount('instance:removed')).toBe(0);
      expect(manager.listenerCount('instance:yolo-toggled')).toBe(0);
      expect(manager.listenerCount('instance:interrupt-requested')).toBe(0);
      expect(manager.listenerCount('instance:input-required-resolved')).toBe(1); // the test's own listener
      expect(orchestration.listenerCount('user-action-resolved')).toBe(0);
    });
  });
});
