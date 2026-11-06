import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderRuntimeEvent, ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { InstanceEventsService } from '../../core/services/instance-events.service';
import { IpcEventBusService } from '../../core/services/ipc/ipc-event-bus.service';
import { RunFailureStateService, SAFE_CONTINUATION } from './run-failure-state.service';

describe('RunFailureStateService', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setup() {
    const events$ = new Subject<ProviderRuntimeEventEnvelope>();
    const removed$ = new Subject<string>();
    TestBed.configureTestingModule({ providers: [
      RunFailureStateService,
      { provide: InstanceEventsService, useValue: { events$ } },
      { provide: IpcEventBusService, useValue: { instanceRemoved$: removed$ } },
    ] });
    const service = TestBed.inject(RunFailureStateService);
    let seq = 0;
    const emit = (event: ProviderRuntimeEvent, generation: number | null = 1, turnId = 'turn') => events$.next({
      eventId: `event-${++seq}`, instanceId: 'session', provider: 'codex', seq,
      timestamp: 1000 + seq, ...(generation === null ? {} : { adapterGeneration: generation }), turnId, event,
    });
    return { service, emit, removed$ };
  }

  it('shows a failed completion even when partial output was returned, with raw text only in Details', () => {
    const { service, emit } = setup();
    emit({ kind: 'error', message: 'PRIVATE_PROVIDER_DIAGNOSTIC', recoverable: false });
    emit({ kind: 'complete', turnErrored: true });
    const failure = service.forInstance('session');
    expect(failure?.presentation.rawDetail).toBe('PRIVATE_PROVIDER_DIAGNOSTIC');
    expect(failure?.presentation.headline).not.toContain('PRIVATE_PROVIDER_DIAGNOSTIC');
  });

  it('clears a failure on a successful turn and rejects a stale adapter generation', () => {
    const { service, emit } = setup();
    emit({ kind: 'complete', turnErrored: true });
    emit({ kind: 'complete', turnEnding: { reason: 'completed', evidence: 'provider_completed' } }, 2);
    emit({ kind: 'complete', turnErrored: true }, 1);
    expect(service.forInstance('session')).toBeUndefined();
  });

  it('does not offer a manual retry while the provider is already retrying', () => {
    const { service, emit } = setup();
    emit({ kind: 'error', message: 'retry in progress', turnEnding: {
      reason: 'retryable', evidence: 'provider_transient_error', providerRetrying: true,
    } });
    expect(service.forInstance('session')).toBeUndefined();
  });

  it('does not turn a user interruption into a failure', () => {
    const { service, emit } = setup();
    emit({ kind: 'complete', degradedReason: 'cancelled', turnErrored: true });
    expect(service.forInstance('session')).toBeUndefined();
  });

  it('shows a classified process crash without promoting its numeric exit status into the headline', () => {
    const { service, emit } = setup();
    emit({ kind: 'exit', code: 7, signal: null, turnEnding: { reason: 'crash', evidence: 'active_process_exit' } });
    expect(service.forInstance('session')?.presentation.headline).toContain('Codex stopped');
    expect(service.forInstance('session')?.presentation.headline).not.toContain('7');
    expect(service.forInstance('session')?.presentation.rawDetail).toContain('7');
  });

  it('does not guess a failed turn from an unclassified process exit', () => {
    const { service, emit } = setup();
    emit({ kind: 'exit', code: 1, signal: null });
    expect(service.forInstance('session')).toBeUndefined();
  });

  it('forgets state when the session is removed', () => {
    const { service, emit, removed$ } = setup();
    emit({ kind: 'complete', turnErrored: true });
    removed$.next('session');
    expect(service.forInstance('session')).toBeUndefined();
  });

  it('accepts an unversioned main-process user message after versioned adapter events', () => {
    const { service, emit } = setup();
    emit({ kind: 'complete', turnErrored: true }, 2);
    emit({ kind: 'output', messageType: 'user', content: 'A new request' }, null);
    expect(service.forInstance('session')).toBeUndefined();
  });

  it('uses a continuation prompt which checks completed actions before retrying', () => {
    expect(SAFE_CONTINUATION).toBe('Continue from where you stopped. Check which actions already completed before retrying anything.');
  });
});
