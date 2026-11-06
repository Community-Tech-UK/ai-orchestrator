import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { Router } from '@angular/router';
import { CouncilPrefillService } from '../compare/council-prefill.service';
import { IpcFacadeService } from '../../core/services/ipc';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';
import { InstanceStore } from '../../core/state/instance/instance.store';
import { ReplyMenuActions } from './reply-menu-actions';

function setup() {
  const navigate = vi.fn().mockResolvedValue(true);
  const requestReview = vi.fn().mockResolvedValue({ success: true });
  const forkSession = vi.fn().mockResolvedValue({ success: true, data: { id: 'fork-1' } });
  const setSelectedInstance = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      ReplyMenuActions,
      { provide: Router, useValue: { navigate } },
      { provide: CrossModelReviewIpcService, useValue: { requestReview } },
      { provide: IpcFacadeService, useValue: { forkSession } },
      { provide: InstanceStore, useValue: { setSelectedInstance } },
    ],
  });
  return {
    actions: TestBed.inject(ReplyMenuActions),
    prefill: TestBed.inject(CouncilPrefillService),
    navigate,
    requestReview,
    forkSession,
    setSelectedInstance,
  };
}

describe('ReplyMenuActions', () => {
  it('fills Council with the given context and opens the page', () => {
    const { actions, prefill, navigate } = setup();
    expect(prefill.take()).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    actions.openAskCouncil('prompt text');
    expect(prefill.take()).toBe('prompt text');
    expect(navigate).toHaveBeenCalledExactlyOnceWith(['/ask-council']);
  });

  it('requests the session second opinion for the given instance', () => {
    const { actions, requestReview } = setup();
    actions.requestReview('session-1');
    expect(requestReview).toHaveBeenCalledExactlyOnceWith('session-1');
  });

  it('forks at the given message and selects the new session', async () => {
    const { actions, forkSession, setSelectedInstance } = setup();
    await actions.forkFromMessage('session-1', 2);
    expect(forkSession).toHaveBeenCalledExactlyOnceWith('session-1', 3, 'Fork at message 3');
    expect(setSelectedInstance).toHaveBeenCalledExactlyOnceWith('fork-1');
  });

  it('forks nothing without an instance id or message index', async () => {
    const { actions, forkSession, setSelectedInstance } = setup();
    await actions.forkFromMessage('', 2);
    await actions.forkFromMessage('session-1', undefined);
    expect(forkSession).not.toHaveBeenCalled();
    expect(setSelectedInstance).not.toHaveBeenCalled();
  });
});
