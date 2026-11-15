import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstanceStore } from '../state/instance.store';
import { SideChatStore } from '../state/side-chat.store';
import { ChatStore } from '../state/chat.store';
import { ChatIpcService } from './ipc/chat-ipc.service';
import { ToastService } from './toast.service';
import type { ChatRecord } from '../../../../shared/types/chat.types';
import { SessionNavigator } from './session-navigator.service';

describe('SessionNavigator', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('selects the session before navigating home from a secondary page', () => {
    const calls: string[] = [];
    const setSelectedInstance = vi.fn((id) => calls.push(id));
    const navigate = vi.fn(() => { calls.push('/'); return Promise.resolve(true); });
    TestBed.configureTestingModule({ providers: [
      { provide: InstanceStore, useValue: { setSelectedInstance, getInstance: vi.fn(() => null) } },
      { provide: SideChatStore, useValue: { requestOpenForRuntime: vi.fn(() => false) } }, { provide: Router, useValue: { navigate } },
    ] });
    TestBed.inject(SessionNavigator).openSession('a');
    expect(calls).toEqual(['a', '/']); expect(navigate).toHaveBeenCalledWith(['/']);
  });
  it.each(['processing', 'waiting_for_input'])(
    'opens the parent panel for a hidden sidechat %s request without selecting its runtime', async (status) => {
      const parent = { kind: 'session' as const, historyThreadId: 'parent-thread', originNodeId: null };
      const sidechat: ChatRecord = {
        id: 'side-chat', name: 'Release question', provider: 'claude', model: null, reasoningEffort: null,
        currentCwd: '/work', projectId: null, yolo: false, ledgerThreadId: 'side-thread',
        currentInstanceId: 'hidden-runtime', createdAt: 1, lastActiveAt: 1, archivedAt: null,
        sideChatParentKey: 'session:parent-thread',
      };
      const setSelectedInstance = vi.fn();
      const navigate = vi.fn().mockResolvedValue(true);
      TestBed.configureTestingModule({ providers: [
        { provide: InstanceStore, useValue: { setSelectedInstance,
          getInstance: vi.fn(() => ({ status, metadata: { hideFromProjectRail: true, sideChatId: 'side-chat' } })) } },
        { provide: ChatStore, useValue: { chats: signal([sidechat]), details: signal(new Map()) } },
        { provide: ChatIpcService, useValue: {
          onChatEvent: vi.fn(() => () => undefined),
          sideChatAttentionAll: vi.fn().mockResolvedValue({ success: true, data: [{
            parent, parentTitle: 'Parent session', total: 1, running: 0, unread: 0,
            needsAttention: 0, attentionSince: null, targetChatId: null,
          }] }),
        } },
        { provide: Router, useValue: { navigate } },
      ] });
      const sidechats = TestBed.inject(SideChatStore);
      await sidechats.initialize();
      expect(sidechats.attentionList()).toEqual([]);

      TestBed.inject(SessionNavigator).openSession('hidden-runtime');

      expect(sidechats.openRequest()).toMatchObject({ parent, chatId: 'side-chat' });
      expect(setSelectedInstance).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith(['/']);
      sidechats.disposeForTesting();
    },
  );

  it('reports an unavailable parent instead of selecting a hidden runtime', () => {
    const setSelectedInstance = vi.fn();
    TestBed.configureTestingModule({ providers: [
      { provide: InstanceStore, useValue: { setSelectedInstance,
        getInstance: vi.fn(() => ({ metadata: { hideFromProjectRail: true, sideChatId: 'side-chat' } })) } },
      { provide: SideChatStore, useValue: { requestOpenForRuntime: vi.fn(() => false) } },
      { provide: Router, useValue: { navigate: vi.fn() } },
    ] });

    TestBed.inject(SessionNavigator).openSession('hidden-runtime');

    expect(setSelectedInstance).not.toHaveBeenCalled();
    expect(TestBed.inject(ToastService).toasts()[0]?.text).toContain('Could not open this sidechat');
  });

});
