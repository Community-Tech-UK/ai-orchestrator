import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../db/sqlite-driver';
import {
  getSessionAdmissionService,
  _resetSessionAdmissionServiceForTesting,
  type SessionAdmissionInstanceHost,
  type AdmissionInstanceView,
  type AdmitAutomatedWriteRequest,
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
  private runtimeSnapshots = new Map<string, {
    activeTurnId: string | null;
    turnPhase: string;
  }>();

  setInstance(id: string, view: AdmissionInstanceView): void {
    this.instances.set(id, view);
  }

  removeInstanceRecord(id: string): void {
    this.instances.delete(id);
  }

  getInstance(id: string): AdmissionInstanceView | undefined {
    return this.instances.get(id);
  }

  setRuntimeSnapshot(
    id: string,
    snapshot: { activeTurnId: string | null; turnPhase: string },
  ): void {
    this.runtimeSnapshots.set(id, snapshot);
  }

  getAdapter(id: string): { getRuntimeSnapshot: () => {
    activeTurnId: string | null;
    turnPhase: string;
  } } | undefined {
    const snapshot = this.runtimeSnapshots.get(id);
    return snapshot ? { getRuntimeSnapshot: () => snapshot } : undefined;
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

    it('opt-in ready admission suppresses while lifecycle or provider runtime still owns a turn', () => {
      const strictRequest = {
        instanceId: 'i1',
        origin: 'browser-gateway',
        message: 'resume after approval',
        requireReadyForInput: true,
      } as const;

      im.setInstance('i1', { status: 'busy' as never });
      im.setRuntimeSnapshot('i1', { activeTurnId: 'turn-1', turnPhase: 'running' });
      expect(getSessionAdmissionService().admitAutomatedWrite(strictRequest)).toMatchObject({
        kind: 'suppressed',
      });

      im.setInstance('i1', { status: 'idle' as never });
      expect(getSessionAdmissionService().admitAutomatedWrite(strictRequest)).toMatchObject({
        kind: 'suppressed',
      });

      im.setRuntimeSnapshot('i1', { activeTurnId: null, turnPhase: 'starting' });
      expect(getSessionAdmissionService().admitAutomatedWrite(strictRequest)).toMatchObject({
        kind: 'suppressed',
      });
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
    it('keeps a respawning child completion pending through the fallback ready edge until reconciliation fails it', () => {
      const service = getSessionAdmissionService();
      im.setInstance('i1', { status: 'respawning' as never });
      const completion = service.admitAutomatedWrite({
        instanceId: 'i1', origin: 'orchestration', message: 'child complete',
        sourceMetadata: { action: 'child_completed', data: { childId: 'child-1' } },
      });
      expect(completion).toMatchObject({ kind: 'suppressed', reason: 'respawning' });
      const redelivered = vi.fn();
      service.registerRedeliveryHandler('orchestration', redelivered);

      const release = service.holdRespawningChildCompletions('i1');
      im.setInstance('i1', { status: 'idle' as never });
      im.emitStateUpdate('i1', 'idle');
      expect(redelivered).not.toHaveBeenCalled();
      expect(service.listAdmissions({}).find((row) => row.admissionId === completion.admissionId)?.state)
        .toBe('suppressed');

      service.markFailed(completion.admissionId, 'represented in fallback notice');
      release();
      im.emitStateUpdate('i1', 'idle');
      expect(redelivered).not.toHaveBeenCalled();
      expect(service.listAdmissions({}).find((row) => row.admissionId === completion.admissionId)?.state)
        .toBe('failed');
    });

    it('releases held child completions after native resume and leaves other ready-edge writes unaffected', () => {
      const service = getSessionAdmissionService();
      im.setInstance('i1', { status: 'respawning' as never });
      service.admitAutomatedWrite({
        instanceId: 'i1', origin: 'orchestration', message: 'child complete',
        sourceMetadata: { action: 'child_completed' },
      });
      service.admitAutomatedWrite({ instanceId: 'i1', origin: 'reaction', message: 'nudge' });
      const completionHandler = vi.fn();
      const reactionHandler = vi.fn();
      service.registerRedeliveryHandler('orchestration', completionHandler);
      service.registerRedeliveryHandler('reaction', reactionHandler);

      const release = service.holdRespawningChildCompletions('i1');
      im.setInstance('i1', { status: 'idle' as never });
      im.emitStateUpdate('i1', 'idle');
      expect(completionHandler).not.toHaveBeenCalled();
      expect(reactionHandler).toHaveBeenCalledTimes(1);
      release();
      expect(completionHandler).toHaveBeenCalledTimes(1);
    });

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

    it('coalesces strict redelivery until a ready edge with no active provider turn', () => {
      im.setInstance('i1', { status: 'busy' as never });
      im.setRuntimeSnapshot('i1', { activeTurnId: 'turn-1', turnPhase: 'running' });
      const firstRequest = {
        instanceId: 'i1',
        origin: 'browser-gateway',
        message: 'Browser approval request request-1 was approved.',
        requireReadyForInput: true,
        coalesceKey: 'browser-approval-resume',
      } as AdmitAutomatedWriteRequest & { coalesceKey: string };
      const secondRequest = {
        ...firstRequest,
        message: 'Browser approval request request-2 was denied.',
      };
      const first = getSessionAdmissionService().admitAutomatedWrite(firstRequest);
      const second = getSessionAdmissionService().admitAutomatedWrite(secondRequest);
      expect(first.kind).toBe('suppressed');
      expect(second.kind).toBe('suppressed');

      const handler = vi.fn();
      getSessionAdmissionService().registerRedeliveryHandler('browser-gateway', handler);

      im.setInstance('i1', { status: 'idle' as never });
      im.emitStateUpdate('i1', 'idle');
      expect(handler).not.toHaveBeenCalled();

      im.setRuntimeSnapshot('i1', { activeTurnId: null, turnPhase: 'idle' });
      im.emitStateUpdate('i1', 'idle');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        instanceId: 'i1',
        message: expect.stringContaining('request-1 was approved'),
      }));
      expect(handler.mock.calls[0][0].message).toContain('request-2 was denied');

      im.emitStateUpdate('i1', 'idle');
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

  describe('provider-limit hold (orchestration responses)', () => {
    it('holds an orchestration response while the hold applies, and redelivers it once it lifts', () => {
      let limited = true;
      getSessionAdmissionService().setProviderLimitHold(() => limited);
      im.setInstance('i1', { status: 'idle' as never });
      const outcome = getSessionAdmissionService().admitAutomatedWrite({
        instanceId: 'i1', origin: 'orchestration', message: 'child done', sourceMetadata: { action: 'child_completed' },
      });
      expect(outcome).toMatchObject({ kind: 'suppressed', reason: 'provider-limited' });

      const handler = vi.fn();
      getSessionAdmissionService().registerRedeliveryHandler('orchestration', handler);
      im.emitStateUpdate('i1', 'idle');
      expect(handler).not.toHaveBeenCalled();

      limited = false; // the account switch finished, or the park resumed
      im.emitStateUpdate('i1', 'idle');
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0]).toMatchObject({ instanceId: 'i1', message: 'child done' });
    });

    it('does not consult the hold for writers that use the send path and its own preflight', () => {
      const hold = vi.fn(() => true);
      getSessionAdmissionService().setProviderLimitHold(hold);
      im.setInstance('i1', { status: 'idle' as never });
      const outcome = getSessionAdmissionService().admitAutomatedWrite({ instanceId: 'i1', origin: 'reaction', message: 'nudge' });
      expect(outcome.kind).toBe('admitted');
      expect(hold).not.toHaveBeenCalled();
    });

    it('fails open when the hold check throws', () => {
      getSessionAdmissionService().setProviderLimitHold(() => { throw new Error('ledger unreadable'); });
      im.setInstance('i1', { status: 'idle' as never });
      const outcome = getSessionAdmissionService().admitAutomatedWrite({ instanceId: 'i1', origin: 'orchestration', message: 'child done' });
      expect(outcome.kind).toBe('admitted');
    });

    it('requeues an admitted response the provider refused, and redelivers it on a later ready edge', () => {
      let limited = false;
      getSessionAdmissionService().setProviderLimitHold(() => limited);
      im.setInstance('i1', { status: 'idle' as never });
      const request: AdmitAutomatedWriteRequest = {
        instanceId: 'i1', origin: 'orchestration', message: 'child done', sourceMetadata: { action: 'child_completed' },
      };
      const outcome = getSessionAdmissionService().admitAutomatedWrite(request);
      expect(outcome.kind).toBe('admitted');

      limited = true; // the refusal handed the limit to a switch or park
      getSessionAdmissionService().requeueUndelivered(outcome.admissionId, request, 'provider-limited');
      expect(SessionAdmissionStore.getInstance(testDb).get(outcome.admissionId))
        .toMatchObject({ state: 'suppressed', suppressReason: 'provider-limited' });

      const handler = vi.fn();
      getSessionAdmissionService().registerRedeliveryHandler('orchestration', handler);
      im.emitStateUpdate('i1', 'idle');
      expect(handler).not.toHaveBeenCalled();
      limited = false;
      im.emitStateUpdate('i1', 'idle');
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0]).toMatchObject({ admissionId: outcome.admissionId, message: 'child done' });
    });
  });

  describe('provider-limit requeue without an admission row', () => {
    it('creates a suppressed row and redelivers it once the hold lifts', () => {
      let limited = true;
      getSessionAdmissionService().setProviderLimitHold(() => limited);
      im.setInstance('i1', { status: 'idle' as never });
      getSessionAdmissionService().requeueUndelivered(undefined, {
        instanceId: 'i1', origin: 'orchestration', message: 'consensus done', sourceMetadata: { action: 'consensus_query' },
      }, 'provider-limited');
      expect(SessionAdmissionStore.getInstance(testDb).list({ instanceId: 'i1' }))
        .toEqual([expect.objectContaining({ state: 'suppressed', suppressReason: 'provider-limited', origin: 'orchestration' })]);

      const handler = vi.fn();
      getSessionAdmissionService().registerRedeliveryHandler('orchestration', handler);
      im.emitStateUpdate('i1', 'idle');
      expect(handler).not.toHaveBeenCalled();
      limited = false;
      im.emitStateUpdate('i1', 'idle');
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0]).toMatchObject({ message: 'consensus done', sourceMetadata: { action: 'consensus_query' } });
    });
  });

  describe('consensus results and replaced adapters', () => {
    it('holds a consensus result while the provider-limit hold applies', () => {
      let limited = true;
      getSessionAdmissionService().setProviderLimitHold(() => limited);
      im.setInstance('i1', { status: 'idle' as never });
      expect(getSessionAdmissionService().admitAutomatedWrite({ instanceId: 'i1', origin: 'consensus', message: 'consensus done' }))
        .toMatchObject({ kind: 'suppressed', reason: 'provider-limited' });
      const handler = vi.fn();
      getSessionAdmissionService().registerRedeliveryHandler('consensus', handler);
      limited = false;
      im.emitStateUpdate('i1', 'idle');
      expect(handler).toHaveBeenCalledOnce();
    });

    it('redelivers a write whose adapter was replaced as soon as the session can already take it', async () => {
      im.setInstance('i1', { status: 'idle' as never });
      const request: AdmitAutomatedWriteRequest = { instanceId: 'i1', origin: 'orchestration', message: 'child done' };
      const outcome = getSessionAdmissionService().admitAutomatedWrite(request);
      const handler = vi.fn();
      getSessionAdmissionService().registerRedeliveryHandler('orchestration', handler);
      expect(getSessionAdmissionService().requeueUndelivered(outcome.admissionId, request, 'respawning')).toBe(outcome.admissionId);
      expect(handler).not.toHaveBeenCalled(); // the caller records the id first
      await Promise.resolve();
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0]).toMatchObject({ admissionId: outcome.admissionId, message: 'child done' });
    });

    it('keeps a replaced-adapter write pending while the replacement is still starting, then delivers it', async () => {
      // An account switch and a restart both respawn through `initializing`, not `respawning`.
      im.setInstance('i1', { status: 'initializing' as never });
      const request: AdmitAutomatedWriteRequest = { instanceId: 'i1', origin: 'orchestration', message: 'child done' };
      const handler = vi.fn();
      getSessionAdmissionService().registerRedeliveryHandler('orchestration', handler);
      getSessionAdmissionService().requeueUndelivered('row-2', request, 'respawning');
      await Promise.resolve();
      expect(handler).not.toHaveBeenCalled();
      im.setInstance('i1', { status: 'busy' as never });
      im.setRuntimeSnapshot('i1', { activeTurnId: 'turn-1', turnPhase: 'running' });
      im.emitStateUpdate('i1', 'ready');
      expect(handler).not.toHaveBeenCalled();
      im.setInstance('i1', { status: 'idle' as never });
      im.setRuntimeSnapshot('i1', { activeTurnId: null, turnPhase: 'idle' });
      im.emitStateUpdate('i1', 'idle');
      expect(handler).toHaveBeenCalledOnce();
    });

    it('fails a requeued write whose session is gone instead of keeping it forever', async () => {
      im.setInstance('i1', { status: 'idle' as never });
      const request: AdmitAutomatedWriteRequest = { instanceId: 'i1', origin: 'orchestration', message: 'child done' };
      const outcome = getSessionAdmissionService().admitAutomatedWrite(request);
      im.removeInstanceRecord('i1');
      const handler = vi.fn();
      getSessionAdmissionService().registerRedeliveryHandler('orchestration', handler);
      expect(getSessionAdmissionService().requeueUndelivered(outcome.admissionId, request, 'respawning')).toBeNull();
      expect(SessionAdmissionStore.getInstance(testDb).get(outcome.admissionId)).toMatchObject({ state: 'failed' });
      im.setInstance('i1', { status: 'idle' as never });
      im.emitStateUpdate('i1', 'idle');
      await Promise.resolve();
      expect(handler).not.toHaveBeenCalled();
    });

    it('keeps a replaced-adapter write pending while the session is still respawning', async () => {
      im.setInstance('i1', { status: 'respawning' as never });
      const request: AdmitAutomatedWriteRequest = { instanceId: 'i1', origin: 'orchestration', message: 'child done' };
      const handler = vi.fn();
      getSessionAdmissionService().registerRedeliveryHandler('orchestration', handler);
      getSessionAdmissionService().requeueUndelivered('row-1', request, 'respawning');
      await Promise.resolve();
      expect(handler).not.toHaveBeenCalled();
      im.setInstance('i1', { status: 'idle' as never });
      im.emitStateUpdate('i1', 'idle');
      expect(handler).toHaveBeenCalledOnce();
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
