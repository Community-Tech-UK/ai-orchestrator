import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../db/sqlite-driver';
import {
  getSessionAdmissionService,
  _resetSessionAdmissionServiceForTesting,
  type SessionAdmissionInstanceHost,
  type AdmissionInstanceView,
  type RedeliveryContext,
} from './session-admission-service';
import { SessionAdmissionStore } from './session-admission-store';

let testDb: SqliteDriver;
let rlmThrows = false;

vi.mock('../persistence/rlm-database', () => ({
  getRLMDatabase: () => {
    if (rlmThrows) throw new Error('rlm unavailable');
    return { getRawDb: () => testDb };
  },
}));

class FakeInstanceManager extends EventEmitter implements SessionAdmissionInstanceHost {
  private instances = new Map<string, AdmissionInstanceView>();

  setInstance(id: string, view: AdmissionInstanceView): void {
    this.instances.set(id, view);
  }

  removeInstanceRecord(id: string): void {
    this.instances.delete(id);
  }

  getInstance(id: string): AdmissionInstanceView | undefined {
    return this.instances.get(id);
  }

  emitStateUpdate(instanceId: string, status: string): void {
    this.emit('instance:state-update', { instanceId, status });
  }

  emitBatchUpdate(updates: { instanceId: string; status: string }[]): void {
    this.emit('instance:batch-update', { updates });
  }

  emitRemoved(instanceId: string): void {
    this.emit('instance:removed', instanceId);
  }
}

describe('SessionAdmissionService', () => {
  let im: FakeInstanceManager;

  beforeEach(() => {
    testDb = new Database(':memory:') as unknown as SqliteDriver;
    rlmThrows = false;
    SessionAdmissionStore._resetForTesting();
    _resetSessionAdmissionServiceForTesting();
    im = new FakeInstanceManager();
    getSessionAdmissionService().setInstanceManager(im);
  });

  describe('admitAutomatedWrite suppression reasons', () => {
    it('suppresses with unknown-instance when the instance is not found', () => {
      const outcome = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'ghost',
        origin: 'reaction',
        message: 'hi',
      });
      expect(outcome).toMatchObject({ kind: 'suppressed', reason: 'unknown-instance' });
    });

    it('suppresses with unknown-instance when no InstanceManager is attached', () => {
      _resetSessionAdmissionServiceForTesting();
      const outcome = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'i1',
        origin: 'reaction',
        message: 'hi',
      });
      expect(outcome).toMatchObject({ kind: 'suppressed', reason: 'unknown-instance' });
    });

    it('suppresses with awaiting-human on waiting_for_permission', () => {
      im.setInstance('i1', { status: 'waiting_for_permission' as never });
      const outcome = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'i1', origin: 'reaction', message: 'hi',
      });
      expect(outcome).toMatchObject({ kind: 'suppressed', reason: 'awaiting-human' });
    });

    it.each(['interrupting', 'cancelling', 'interrupt-escalating'])(
      'suppresses with interrupting on status %s',
      (status) => {
        im.setInstance('i1', { status: status as never });
        const outcome = getSessionAdmissionService().admitAutomatedWrite({
          instanceId: 'i1', origin: 'reaction', message: 'hi',
        });
        expect(outcome).toMatchObject({ kind: 'suppressed', reason: 'interrupting' });
      },
    );

    it('suppresses with respawning', () => {
      im.setInstance('i1', { status: 'respawning' as never });
      const outcome = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'i1', origin: 'reaction', message: 'hi',
      });
      expect(outcome).toMatchObject({ kind: 'suppressed', reason: 'respawning' });
    });

    it.each(['error', 'terminated'])('suppresses with terminal on status %s', (status) => {
      im.setInstance('i1', { status: status as never });
      const outcome = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'i1', origin: 'reaction', message: 'hi',
      });
      expect(outcome).toMatchObject({ kind: 'suppressed', reason: 'terminal' });
    });

    it('suppresses with quota-parked when idle but quota-park waitReason is set', () => {
      im.setInstance('i1', {
        status: 'idle' as never,
        waitReason: { kind: 'quota-park', provider: 'codex', resumeAt: Date.now() + 1000 } as never,
      });
      const outcome = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'i1', origin: 'reaction', message: 'hi',
      });
      expect(outcome).toMatchObject({ kind: 'suppressed', reason: 'quota-parked' });
    });

    it('suppresses with auth-required', () => {
      im.setInstance('i1', {
        status: 'idle' as never,
        waitReason: { kind: 'auth-required', provider: 'claude', since: Date.now() } as never,
      });
      const outcome = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'i1', origin: 'reaction', message: 'hi',
      });
      expect(outcome).toMatchObject({ kind: 'suppressed', reason: 'auth-required' });
    });

    it.each(['requested', 'accepted'])('suppresses with interrupting on interruptPhase %s', (phase) => {
      im.setInstance('i1', { status: 'idle' as never, interruptPhase: phase });
      const outcome = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'i1', origin: 'reaction', message: 'hi',
      });
      expect(outcome).toMatchObject({ kind: 'suppressed', reason: 'interrupting' });
    });

    it('admits when the instance is idle with no wait state', () => {
      im.setInstance('i1', { status: 'idle' as never });
      const outcome = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'i1', origin: 'reaction', message: 'hi',
      });
      expect(outcome.kind).toBe('admitted');
    });

    it('admits while busy (mid-turn tool-result-style injection is expected to succeed)', () => {
      im.setInstance('i1', { status: 'busy' as never });
      const outcome = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'i1', origin: 'consensus', message: 'hi',
      });
      expect(outcome.kind).toBe('admitted');
    });
  });

  describe('persistence', () => {
    it('persists an admitted row as recorded and a suppressed row as suppressed', () => {
      im.setInstance('i1', { status: 'idle' as never });
      im.setInstance('i2', { status: 'waiting_for_permission' as never });

      const admitted = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'i1', origin: 'reaction', message: 'ok',
      });
      const suppressed = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'i2', origin: 'reaction', message: 'blocked',
      });

      const rows = getSessionAdmissionService().listAdmissions({});
      const admittedRow = rows.find((r) => r.admissionId === admitted.admissionId);
      const suppressedRow = rows.find((r) => r.admissionId === suppressed.admissionId);
      expect(admittedRow?.state).toBe('recorded');
      expect(suppressedRow?.state).toBe('suppressed');
      expect(suppressedRow?.suppressReason).toBe('awaiting-human');
    });

    it('the safety decision does not depend on the store being available', () => {
      rlmThrows = true;
      im.setInstance('i1', { status: 'waiting_for_permission' as never });
      im.setInstance('i2', { status: 'idle' as never });

      const suppressed = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'i1', origin: 'reaction', message: 'x',
      });
      const admitted = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'i2', origin: 'reaction', message: 'x',
      });
      expect(suppressed.kind).toBe('suppressed');
      expect(admitted.kind).toBe('admitted');
      expect(suppressed.admissionId).toBeTruthy();
      expect(admitted.admissionId).toBeTruthy();
      // listAdmissions is also fail-soft when the store is unavailable.
      expect(getSessionAdmissionService().listAdmissions({})).toEqual([]);
    });
  });

  describe('markDelivered / markFailed', () => {
    it('transitions a recorded admission to delivered', () => {
      im.setInstance('i1', { status: 'idle' as never });
      const outcome = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'i1', origin: 'reaction', message: 'ok',
      });
      expect(outcome.kind).toBe('admitted');
      getSessionAdmissionService().markDelivered(outcome.admissionId);
      const row = getSessionAdmissionService().listAdmissions({}).find((r) => r.admissionId === outcome.admissionId);
      expect(row?.state).toBe('delivered');
      expect(row?.deliveredAt).not.toBeNull();
    });

    it('transitions to failed with an error message', () => {
      im.setInstance('i1', { status: 'idle' as never });
      const outcome = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'i1', origin: 'reaction', message: 'ok',
      });
      expect(outcome.kind).toBe('admitted');
      getSessionAdmissionService().markFailed(outcome.admissionId, 'network down');
      const row = getSessionAdmissionService().listAdmissions({}).find((r) => r.admissionId === outcome.admissionId);
      expect(row?.state).toBe('failed');
      expect(row?.errorText).toBe('network down');
    });
  });

  describe('redelivery on ready edge', () => {
    it('refires the registered handler for the origin once the instance reaches a ready status', () => {
      im.setInstance('i1', { status: 'waiting_for_permission' as never });
      const outcome = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'i1',
        origin: 'reaction',
        message: 'nudge',
        contextBlock: 'ctx',
        sourceMetadata: { foo: 'bar' },
      });
      expect(outcome.kind).toBe('suppressed');

      const received: RedeliveryContext[] = [];
      getSessionAdmissionService().registerRedeliveryHandler('reaction', (ctx) => {
        received.push(ctx);
      });

      // Status flips to idle, but a real redelivery must re-check live state.
      im.setInstance('i1', { status: 'idle' as never });
      im.emitStateUpdate('i1', 'idle');

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        instanceId: 'i1',
        message: 'nudge',
        contextBlock: 'ctx',
        sourceMetadata: { foo: 'bar' },
      });
      if (outcome.kind === 'suppressed') {
        expect(received[0].admissionId).toBe(outcome.admissionId);
      }
    });

    it('does NOT refire when the status flips ready but the instance is still quota-parked', () => {
      im.setInstance('i1', { status: 'waiting_for_permission' as never });
      const outcome = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'i1', origin: 'reaction', message: 'nudge',
      });
      expect(outcome.kind).toBe('suppressed');

      const handler = vi.fn();
      getSessionAdmissionService().registerRedeliveryHandler('reaction', handler);

      im.setInstance('i1', {
        status: 'idle' as never,
        waitReason: { kind: 'quota-park', provider: 'codex', resumeAt: Date.now() + 1000 } as never,
      });
      im.emitStateUpdate('i1', 'idle');

      expect(handler).not.toHaveBeenCalled();
    });

    it('refires via instance:batch-update too', () => {
      im.setInstance('i1', { status: 'waiting_for_permission' as never });
      const outcome = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'i1', origin: 'automation', message: 'nudge',
      });
      expect(outcome.kind).toBe('suppressed');

      const handler = vi.fn();
      getSessionAdmissionService().registerRedeliveryHandler('automation', handler);

      im.setInstance('i1', { status: 'ready' as never });
      im.emitBatchUpdate([{ instanceId: 'i1', status: 'ready' }]);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('leaves the row pending (no crash) when no handler is registered for the origin', () => {
      im.setInstance('i1', { status: 'waiting_for_permission' as never });
      const outcome = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'i1', origin: 'lsp-feedback', message: 'nudge',
      });
      expect(outcome.kind).toBe('suppressed');

      im.setInstance('i1', { status: 'idle' as never });
      expect(() => im.emitStateUpdate('i1', 'idle')).not.toThrow();

      const row = getSessionAdmissionService().listAdmissions({}).find((r) => r.admissionId === (outcome as { admissionId: string }).admissionId);
      expect(row?.state).toBe('suppressed');
    });

    it('expires unhandled suppressed rows on sweep()', () => {
      im.setInstance('i1', { status: 'waiting_for_permission' as never });
      const outcome = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'i1', origin: 'lsp-feedback', message: 'nudge',
      });
      expect(outcome.kind).toBe('suppressed');

      getSessionAdmissionService().sweep();

      const row = getSessionAdmissionService().listAdmissions({}).find((r) => r.admissionId === (outcome as { admissionId: string }).admissionId);
      expect(row?.state).toBe('expired');
    });

    it('expires pending suppressed rows when the instance is removed', () => {
      im.setInstance('i1', { status: 'waiting_for_permission' as never });
      const outcome = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'i1', origin: 'reaction', message: 'nudge',
      });
      expect(outcome.kind).toBe('suppressed');

      const handler = vi.fn();
      getSessionAdmissionService().registerRedeliveryHandler('reaction', handler);

      im.removeInstanceRecord('i1');
      im.emitRemoved('i1');

      const row = getSessionAdmissionService().listAdmissions({}).find((r) => r.admissionId === (outcome as { admissionId: string }).admissionId);
      expect(row?.state).toBe('expired');

      // And it must not still be sitting in the pending map waiting to refire.
      im.setInstance('i1', { status: 'idle' as never });
      im.emitStateUpdate('i1', 'idle');
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('recordUserSend (observe-only)', () => {
    it('records a user send and transitions it to delivered', () => {
      const rec = getSessionAdmissionService().recordUserSend('i1', 'hello there', undefined, null);
      expect(rec).not.toBeNull();
      getSessionAdmissionService().markDelivered(rec!.admissionId);
      const row = getSessionAdmissionService().listAdmissions({}).find((r) => r.admissionId === rec!.admissionId);
      expect(row?.origin).toBe('user');
      expect(row?.state).toBe('delivered');
    });

    it('never throws even when the store is unavailable', () => {
      rlmThrows = true;
      expect(() => getSessionAdmissionService().recordUserSend('i1', 'hello', undefined, null)).not.toThrow();
    });

    it('dedupes against a recent promoting row for the same instance+message instead of inserting a second row', () => {
      const store = SessionAdmissionStore.getInstance(testDb);
      const promoted = store.createQueued({ admissionId: 'promo-1', instanceId: 'i1', message: 'promoted text' });
      store.promoteQueued(promoted.admissionId);

      const rec = getSessionAdmissionService().recordUserSend('i1', 'promoted text', undefined, null);
      expect(rec?.admissionId).toBe(promoted.admissionId);

      const rows = getSessionAdmissionService().listAdmissions({ instanceId: 'i1' });
      expect(rows.filter((r) => r.message === 'promoted text')).toHaveLength(1);
      expect(rows.find((r) => r.admissionId === promoted.admissionId)?.state).toBe('recorded');
    });

    it('does not dedupe against a promoting row for a different instance or different message text', () => {
      const store = SessionAdmissionStore.getInstance(testDb);
      const promoted = store.createQueued({ admissionId: 'promo-2', instanceId: 'i1', message: 'exact text' });
      store.promoteQueued(promoted.admissionId);

      const wrongInstance = getSessionAdmissionService().recordUserSend('i2', 'exact text', undefined, null);
      const wrongMessage = getSessionAdmissionService().recordUserSend('i1', 'different text', undefined, null);

      expect(wrongInstance?.admissionId).not.toBe(promoted.admissionId);
      expect(wrongMessage?.admissionId).not.toBe(promoted.admissionId);
      expect(store.get(promoted.admissionId)?.state).toBe('promoting');
    });

    it('does not dedupe against a stale promoting row outside the match window', () => {
      const store = SessionAdmissionStore.getInstance(testDb);
      const promoted = store.createQueued({ admissionId: 'promo-3', instanceId: 'i1', message: 'stale text' });
      store.promoteQueued(promoted.admissionId);
      testDb.prepare('UPDATE prompt_admissions SET updated_at = ? WHERE admission_id = ?').run(Date.now() - 60_000, promoted.admissionId);

      const rec = getSessionAdmissionService().recordUserSend('i1', 'stale text', undefined, null);
      expect(rec?.admissionId).not.toBe(promoted.admissionId);
      expect(store.get(promoted.admissionId)?.state).toBe('promoting');
    });
  });
});
