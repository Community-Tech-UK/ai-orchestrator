import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileGatewayIpcService } from './ipc/mobile-gateway-ipc.service';
import { MobileCompletionSyncService } from './mobile-completion-sync.service';
import { InstanceQueries } from '../state/instance/instance.queries';
import { InstanceStateService } from '../state/instance/instance-state.service';

function setup() {
  const selectedInstanceId = signal<string | null>(null);
  let phoneViewed: ((instanceId: string) => void) | null = null;
  const unsubscribe = vi.fn();
  const ipc = {
    markViewed: vi.fn().mockResolvedValue(undefined),
    onCompletionViewed: vi.fn((callback: (instanceId: string) => void) => {
      phoneViewed = callback;
      return unsubscribe;
    }),
  };
  const state = { updateInstance: vi.fn() };
  TestBed.configureTestingModule({ providers: [
    { provide: MobileGatewayIpcService, useValue: ipc },
    { provide: InstanceQueries, useValue: { selectedInstanceId } },
    { provide: InstanceStateService, useValue: state },
  ] });
  TestBed.inject(MobileCompletionSyncService);
  TestBed.tick();
  return { selectedInstanceId, ipc, state, unsubscribe, phoneViewed: (id: string) => phoneViewed?.(id) };
}

afterEach(() => TestBed.resetTestingModule());

describe('MobileCompletionSyncService', () => {
  it('tells the phone each time a session is opened on the desktop', () => {
    const { selectedInstanceId, ipc } = setup();
    expect(ipc.markViewed).not.toHaveBeenCalled();

    selectedInstanceId.set('a');
    TestBed.tick();
    selectedInstanceId.set('b');
    TestBed.tick();

    expect(ipc.markViewed.mock.calls).toEqual([['a'], ['b']]);
  });

  it('clears the desktop dot when the phone has seen the session', () => {
    const { state, phoneViewed } = setup();

    phoneViewed('a');

    expect(state.updateInstance).toHaveBeenCalledWith('a', { hasUnreadCompletion: false });
  });

  it('stops listening when torn down', () => {
    const { unsubscribe } = setup();
    TestBed.resetTestingModule();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
