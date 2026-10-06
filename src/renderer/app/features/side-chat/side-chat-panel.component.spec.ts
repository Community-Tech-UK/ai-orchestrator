import { Component, input, output, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SideChatPanelComponent } from './side-chat-panel.component';
import { ChatStore } from '../../core/state/chat.store';
import { SideChatStore } from '../../core/state/side-chat.store';
import { InstanceStore } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';
import { ViewLayoutService } from '../../core/services/view-layout.service';
import { ChatIpcService } from '../../core/services/ipc/chat-ipc.service';
import type { ChatDetail, ChatRecord } from '../../../../shared/types/chat.types';
import type { ConversationMessageRecord } from '../../../../shared/types/conversation-ledger.types';
import type {
  SideChatParentRef,
  SideChatPermissionSummary,
  SideChatSummary,
} from '../../../../shared/types/side-chat.types';
import { SIDE_CHAT_PROVIDERS } from '../../../../shared/types/side-chat.types';
import type { PendingSelection } from '../models/compact-model-picker.types';

const specDirectory = dirname(fileURLToPath(import.meta.url));

const PANEL_TEMPLATE = readFileSync(resolve(specDirectory, './side-chat-panel.component.html'), 'utf8');

await resolveComponentResources((url) =>
  Promise.resolve(url.endsWith('side-chat-panel.component.html') ? PANEL_TEMPLATE : ''));

@Component({ selector: 'app-output-stream', standalone: true, template: '<div class="output-stream"></div>' })
class OutputStreamStub {
  readonly messages = input<unknown[]>([]);
  readonly instanceId = input<string>('');
  readonly asyncAnswerTarget = input<unknown>(null);
  readonly provider = input<string>('');
  readonly showThinking = input(false);
  readonly thinkingDefaultExpanded = input(false);
  readonly showToolMessages = input(false);
  readonly isChild = input(false);
  readonly olderMessagesLoader = input<unknown>(null);
  readonly olderMessagesProbe = input<unknown>(null);
}

@Component({ selector: 'app-compact-model-picker', standalone: true, template: '' })
class PickerStub {
  readonly mode = input('');
  readonly selection = input<PendingSelection | null>(null);
  readonly providers = input<string[] | null>(null);
  readonly disabledReason = input<string | null>(null);
  readonly showSelectionStatus = input(true);
  readonly selectionChange = output<PendingSelection>();
}

@Component({ selector: 'app-activity-status', standalone: true, template: '' })
class ActivityStub {
  readonly status = input('');
  readonly activity = input('');
}

@Component({ selector: 'app-user-action-request', standalone: true, template: '' })
class UserActionStub {
  readonly instanceId = input('');
}

@Component({ selector: 'app-browser-approval-request', standalone: true, template: '' })
class BrowserApprovalStub {
  readonly instanceId = input('');
}

const PARENT_A: SideChatParentRef = { kind: 'session', historyThreadId: 'thread-a', originNodeId: null };
const PARENT_B: SideChatParentRef = { kind: 'session', historyThreadId: 'thread-b', originNodeId: null };

function chat(id: string, provider: ChatRecord['provider'] = 'claude'): ChatRecord {
  return {
    id, name: `Chat ${id}`, provider, model: null, reasoningEffort: null, currentCwd: '/work', projectId: null,
    yolo: false, ledgerThreadId: `t-${id}`, currentInstanceId: null, createdAt: 1, lastActiveAt: 1, archivedAt: null,
  };
}

function message(sequence: number, role: 'user' | 'assistant'): ConversationMessageRecord {
  return {
    id: `m${sequence}`, threadId: 't', nativeMessageId: null, nativeTurnId: null, role, phase: null,
    content: `${role} ${sequence}`, createdAt: sequence, tokenInput: null, tokenOutput: null, rawRef: null,
    rawJson: null, sourceChecksum: null, sequence,
  };
}

function summary(id: string, parent: SideChatParentRef, read: number, latest: number): SideChatSummary {
  return {
    link: { chatId: id, parent, authority: 'inherit-parent', lastReadAssistantSequence: read },
    chat: chat(id), status: null, latestAssistantSequence: latest,
    state: latest > read ? 'unread' : 'idle',
  };
}

const PERMISSIONS: SideChatPermissionSummary = {
  ok: true,
  source: 'live-parent',
  policy: {
    agentToolPermissions: { read: 'allow', write: 'deny', bash: 'ask', web: 'allow', task: 'allow' },
    yoloMode: false, hardened: false, containedExecution: false, browserToolsMode: null,
    computerUseMode: null, mandatoryDenyTools: [], workspaceNode: null, resolvedAt: 1,
  },
  providers: SIDE_CHAT_PROVIDERS.map((provider) => provider === 'claude' || provider === 'local-model'
    ? { provider, available: true, reason: null }
    : { provider, available: false, reason: 'cannot block individual tool categories' }),
};

describe('SideChatPanelComponent', () => {
  let fixture: ComponentFixture<SideChatPanelComponent>;
  let ipc: Record<string, ReturnType<typeof vi.fn>>;
  let details: ReturnType<typeof signal<Map<string, ChatDetail>>>;
  let lists: Map<string, SideChatSummary[]>;
  let visibility: DocumentVisibilityState;

  beforeEach(async () => {
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    lists = new Map();
    details = signal(new Map<string, ChatDetail>());
    ipc = {
      onChatEvent: vi.fn(() => () => undefined),
      sideChatAttentionAll: vi.fn().mockResolvedValue({ success: true, data: [] }),
      sideChatList: vi.fn(async ({ parent }: { parent: SideChatParentRef }) => ({
        success: true,
        data: { active: lists.get(parent.kind === 'session' ? parent.historyThreadId : parent.chatId) ?? [], archived: [] },
      })),
      sideChatPermissions: vi.fn().mockResolvedValue({ success: true, data: PERMISSIONS }),
      sideChatCreate: vi.fn().mockResolvedValue({ success: true, data: { chat: chat('new-side') } }),
      sideChatSend: vi.fn().mockResolvedValue({ success: true, data: { ok: true } }),
      sideChatMarkRead: vi.fn(async ({ chatId, throughSequence }: { chatId: string; throughSequence: number }) => ({
        success: true,
        data: { chatId, parent: PARENT_A, authority: 'inherit-parent', lastReadAssistantSequence: throughSequence },
      })),
      sideChatSetSelection: vi.fn().mockResolvedValue({ success: true, data: { chat: chat('s1') } }),
    };

    await TestBed.configureTestingModule({
      imports: [SideChatPanelComponent],
      providers: [
        { provide: ChatIpcService, useValue: ipc },
        {
          provide: ChatStore,
          useValue: {
            details,
            chats: signal<ChatRecord[]>([]),
            ensureDetailLoaded: vi.fn().mockResolvedValue(undefined),
            archive: vi.fn().mockResolvedValue(undefined),
            sendMessageTo: vi.fn(),
            loadOlderMessagesFor: vi.fn().mockResolvedValue(null),
          },
        },
        {
          provide: InstanceStore,
          useValue: {
            getInstance: vi.fn().mockReturnValue(null),
            instanceActivities: signal(new Map()),
            interruptInstance: vi.fn(),
          },
        },
        {
          provide: SettingsStore,
          useValue: { showThinking: signal(false), thinkingDefaultExpanded: signal(false), showToolMessages: signal(false) },
        },
        { provide: ViewLayoutService, useValue: { sideChatWidth: 360, setSideChatWidth: vi.fn() } },
      ],
    })
      .overrideComponent(SideChatPanelComponent, {
        set: {
          imports: [OutputStreamStub, PickerStub, ActivityStub, UserActionStub, BrowserApprovalStub],
          template: PANEL_TEMPLATE,
          templateUrl: undefined,
          styles: [''],
          styleUrl: undefined,
          styleUrls: [],
        },
      })
      .compileComponents();
    fixture = TestBed.createComponent(SideChatPanelComponent);
  });

  afterEach(() => {
    TestBed.inject(SideChatStore).disposeForTesting();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i += 1) {
      fixture.detectChanges();
      await new Promise((resolveTick) => setTimeout(resolveTick, 0));
      await fixture.whenStable();
    }
    fixture.detectChanges();
  }

  function setDetail(id: string, messages: ConversationMessageRecord[]): void {
    details.update((map) => new Map(map).set(id, {
      chat: chat(id),
      conversation: { thread: {} as ChatDetail['conversation']['thread'], messages },
      currentInstance: null,
    }));
  }

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('opens with no conversation, spawns nothing and names its parent', async () => {
    fixture.componentRef.setInput('parent', PARENT_A);
    fixture.componentRef.setInput('parentTitle', 'Provider Hardening');
    await settle();

    expect(ipc['sideChatCreate']).not.toHaveBeenCalled();
    expect(ipc['sideChatSend']).not.toHaveBeenCalled();
    expect(el().querySelector('.header-title')?.textContent).toContain('Sidechats · Provider Hardening');
    expect(el().querySelector('.empty-title')?.textContent).toContain('Ask on the side');
  });

  it('offers only providers that can enforce the parent\'s permissions, explaining the rest', async () => {
    fixture.componentRef.setInput('parent', PARENT_A);
    fixture.componentRef.setInput('parentSelection', { provider: 'codex', model: 'gpt-5.5' });
    await settle();

    const picker = fixture.debugElement.query((node) => node.componentInstance instanceof PickerStub).componentInstance as PickerStub;
    expect(picker.providers()).toEqual(['claude', 'local-model']);
    // The parent's Codex cannot enforce its restrictions, so the default falls to the first usable provider.
    expect(picker.selection()).toMatchObject({ provider: 'claude' });

    el().querySelector<HTMLButtonElement>('.permission-pill')!.click();
    await settle();
    const details = el().querySelector('.permission-details')?.textContent ?? '';
    expect(details).toContain('Editing files: blocked');
    expect(details).toContain('Approvals: asks before acting');
    expect(details).toContain('Codex');
    expect(el().textContent).not.toMatch(/enable editing/i);
  });

  it('uses the pre-send provider choice for the first question', async () => {
    fixture.componentRef.setInput('parent', PARENT_A);
    fixture.componentRef.setInput('workingDirectory', '/work');
    await settle();
    const picker = fixture.debugElement.query((node) => node.componentInstance instanceof PickerStub).componentInstance as PickerStub;

    picker.selectionChange.emit({ provider: 'local-model', model: 'llama3', reasoning: null, modelRuntimeTarget: null });
    const textarea = el().querySelector<HTMLTextAreaElement>('textarea')!;
    textarea.value = 'What is left?';
    textarea.dispatchEvent(new Event('input'));
    await fixture.componentInstance.send();

    expect(ipc['sideChatCreate']).toHaveBeenCalledWith(expect.objectContaining({
      parent: PARENT_A,
      selection: expect.objectContaining({ provider: 'local-model', model: 'llama3' }),
    }));
    expect(ipc['sideChatSend']).toHaveBeenCalledWith({ chatId: 'new-side', text: 'What is left?' });
  });

  it('restores the exact conversation and draft after the panel is closed and reopened', async () => {
    lists.set('thread-a', [summary('s1', PARENT_A, 0, 0), summary('s2', PARENT_A, 0, 0)]);
    fixture.componentRef.setInput('parent', PARENT_A);
    await settle();
    fixture.componentInstance.selectSideChat('s1');
    TestBed.inject(SideChatStore).setDraft(PARENT_A, 's1', 'half-written question');
    fixture.destroy();

    const reopened = TestBed.createComponent(SideChatPanelComponent);
    reopened.componentRef.setInput('parent', PARENT_A);
    fixture = reopened;
    await settle();

    expect(fixture.componentInstance.sideChatId()).toBe('s1');
    expect(el().querySelector('textarea')?.value).toBe('half-written question');
  });

  it('switches siblings and sessions without mixing drafts or lists', async () => {
    lists.set('thread-a', [summary('a1', PARENT_A, 0, 0), summary('a2', PARENT_A, 0, 0)]);
    lists.set('thread-b', [summary('b1', PARENT_B, 0, 0)]);
    const store = TestBed.inject(SideChatStore);
    fixture.componentRef.setInput('parent', PARENT_A);
    await settle();
    fixture.componentInstance.selectSideChat('a1');
    store.setDraft(PARENT_A, 'a1', 'draft for a1');
    fixture.componentInstance.selectSideChat('a2');
    await settle();
    expect(el().querySelector('textarea')?.value).toBe('');

    fixture.componentRef.setInput('parent', PARENT_B);
    await settle();
    const titles = Array.from(el().querySelectorAll('.selector-title')).map((node) => node.textContent?.trim());
    expect(titles).toEqual(['Chat b1']);
    expect(store.draftFor(PARENT_A, 'a1')).toBe('draft for a1');
  });

  it('labels conversation states in text, not colour alone', async () => {
    lists.set('thread-a', [summary('s1', PARENT_A, 0, 4), summary('s2', PARENT_A, 0, 0)]);
    fixture.componentRef.setInput('parent', PARENT_A);
    fixture.componentInstance.selectSideChat('s2');
    await settle();

    const first = el().querySelector('.selector-item');
    expect(first?.getAttribute('aria-label')).toContain('Unread answer');
    expect(first?.querySelector('.state-chip')?.textContent).toContain('Unread answer');
  });

  it('marks an answer read only while it is visibly on screen', async () => {
    lists.set('thread-a', [summary('s1', PARENT_A, 0, 4)]);
    setDetail('s1', [message(3, 'user'), message(4, 'assistant')]);
    visibility = 'hidden';
    fixture.componentRef.setInput('parent', PARENT_A);
    await settle();
    expect(ipc['sideChatMarkRead']).not.toHaveBeenCalled();

    visibility = 'visible';
    const viewport = el().querySelector<HTMLElement>('.panel-body .output-stream')!;
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 200 });
    viewport.scrollTop = 100;
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(ipc['sideChatMarkRead']).not.toHaveBeenCalled();
    expect(el().querySelector('.new-answer')?.textContent).toContain('New answer');

    viewport.scrollTop = 800;
    viewport.dispatchEvent(new Event('scroll'));
    await settle();
    expect(ipc['sideChatMarkRead']).toHaveBeenCalledWith({ chatId: 's1', throughSequence: 4 });
  });

  it('keeps Close, Stop and Archive as separate actions', async () => {
    lists.set('thread-a', [summary('s1', PARENT_A, 0, 0)]);
    setDetail('s1', []);
    fixture.componentRef.setInput('parent', PARENT_A);
    await settle();
    const closed = vi.fn();
    fixture.componentInstance.closeRequested.subscribe(closed);

    el().querySelector<HTMLButtonElement>('.header-close')!.click();
    expect(closed).toHaveBeenCalled();
    expect(TestBed.inject(ChatStore).archive).not.toHaveBeenCalled();

    el().querySelector<HTMLButtonElement>('.archive-action')!.click();
    await settle();
    expect(TestBed.inject(ChatStore).archive).toHaveBeenCalledWith('s1');
  });

  it('offers an explicit stale-context retry when the parent cannot be read', async () => {
    lists.set('thread-a', [summary('s1', PARENT_A, 0, 0)]);
    setDetail('s1', []);
    ipc['sideChatSend'].mockResolvedValueOnce({
      success: false,
      error: { message: 'Parent session is gone' },
      data: { ok: false, code: 'parent-unavailable', lastSnapshotAvailable: true },
    });
    fixture.componentRef.setInput('parent', PARENT_A);
    await settle();
    TestBed.inject(SideChatStore).setDraft(PARENT_A, 's1', 'Status?');
    await fixture.componentInstance.send();
    await settle();

    const retry = Array.from(el().querySelectorAll<HTMLButtonElement>('.error-banner .link-button'))
      .find((button) => button.textContent?.includes('last saved context'));
    expect(retry).toBeTruthy();
    retry!.click();
    await settle();
    expect(ipc['sideChatSend']).toHaveBeenLastCalledWith({ chatId: 's1', text: 'Status?', allowStaleContext: true });
  });
});
