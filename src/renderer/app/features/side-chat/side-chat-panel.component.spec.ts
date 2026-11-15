import { Component, input, output, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ConfirmService } from '../../shared/confirm/confirm.service';
import { AppIconButtonDirective } from '../../shared/tooltip/icon-button.directive';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { KeybindingService } from '../../core/services/keybinding.service';
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
import type { Instance } from '../../core/state/instance/instance.types';
import {
  UserInputRequestRegistry,
  type QuestionOfferResult,
} from '../instance-detail/user-input-request.registry';

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
        data: { active: lists.get(parent.kind === 'session' ? parent.historyThreadId : parent.chatId) ?? [] },
      })),
      sideChatPermissions: vi.fn().mockResolvedValue({ success: true, data: PERMISSIONS }),
      sideChatCreate: vi.fn().mockResolvedValue({ success: true, data: { chat: chat('new-side') } }),
      sideChatSend: vi.fn().mockResolvedValue({ success: true, data: { ok: true } }),
      sideChatMarkRead: vi.fn(async ({ chatId, throughSequence }: { chatId: string; throughSequence: number }) => ({
        success: true,
        data: { chatId, parent: PARENT_A, authority: 'inherit-parent', lastReadAssistantSequence: throughSequence },
      })),
      sideChatDiscard: vi.fn().mockResolvedValue({ success: true }),
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
        { provide: KeybindingService, useValue: { formatBindingByAction: () => 'Ctrl+Alt+S', ariaShortcutsByAction: () => 'Control+Alt+S' } },
      ],
    })
      .overrideComponent(SideChatPanelComponent, {
        set: {
          imports: [OutputStreamStub, PickerStub, ActivityStub, UserActionStub, BrowserApprovalStub, AioTooltipDirective, AppIconButtonDirective],
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
    expect(el().querySelector('.header-title')?.textContent).toContain('Sidechat · Provider Hardening');
    expect(el().querySelector('.empty-copy')?.textContent).toContain('Ask about Provider Hardening.');
  });

  it('offers only providers that can enforce the parent\'s permissions', async () => {
    fixture.componentRef.setInput('parent', PARENT_A);
    fixture.componentRef.setInput('parentSelection', { provider: 'codex', model: 'gpt-5.5' });
    await settle();

    const picker = fixture.debugElement.query((node) => node.componentInstance instanceof PickerStub).componentInstance as PickerStub;
    expect(picker.providers()).toEqual(['claude', 'local-model']);
    // The parent's Codex cannot enforce its restrictions, so the default falls to the first usable provider.
    expect(picker.selection()).toMatchObject({ provider: 'claude' });

    expect(el().querySelector('.permission-pill')).toBeNull();
    expect(el().textContent).not.toMatch(/enable editing/i);
  });

  it('keeps healthy controls out of the answer area and puts the model below the message box', async () => {
    fixture.componentRef.setInput('parent', PARENT_A);
    fixture.componentRef.setInput('parentTitle', 'Provider Hardening');
    await settle();

    expect(el().querySelector('.permission-pill')).toBeNull();
    expect(el().querySelector('.status-pill')).toBeNull();
    expect(el().querySelector('.sidechat-switcher')).toBeNull();
    expect(el().querySelector('.composer app-compact-model-picker')).toBeTruthy();
    expect(el().querySelector('.empty-copy')?.textContent).toContain('Ask about Provider Hardening. Uses the same permissions as the session.');
    expect(document.activeElement).toBe(el().querySelector('textarea'));
  });

  it('offers a switcher only for siblings and switches to the chosen conversation', async () => {
    lists.set('thread-a', [summary('s1', PARENT_A, 0, 4), summary('s2', PARENT_A, 0, 0)]);
    fixture.componentRef.setInput('parent', PARENT_A);
    await settle();

    const switcher = el().querySelector<HTMLSelectElement>('.sidechat-switcher')!;
    expect(switcher).toBeTruthy();
    expect(Array.from(switcher.options).map(option => option.textContent?.trim())).toEqual(['New sidechat', 'Chat s1 · New answer', 'Chat s2']);
    switcher.value = 's2';
    switcher.dispatchEvent(new Event('change'));
    await settle();
    expect(fixture.componentInstance.sideChatId()).toBe('s2');

    lists.set('thread-a', [summary('s2', PARENT_A, 0, 0)]);
    await TestBed.inject(SideChatStore).refresh(PARENT_A);
    await settle();
    expect(el().querySelector('.sidechat-switcher')).toBeNull();
  });

  it('keeps the sole existing sidechat reachable while drafting a new one without creating a blank conversation', async () => {
    lists.set('thread-a', [summary('s1', PARENT_A, 0, 0)]);
    fixture.componentRef.setInput('parent', PARENT_A);
    await settle();
    expect(fixture.componentInstance.sideChatId()).toBe('s1');
    expect(el().querySelector('.sidechat-switcher')).toBeNull();

    el().querySelector<HTMLButtonElement>('[aria-label="New sidechat"]')!.click();
    TestBed.inject(SideChatStore).setDraft(PARENT_A, null, 'unsent second question');
    await settle();
    const switcher = el().querySelector<HTMLSelectElement>('.sidechat-switcher')!;
    expect(switcher).toBeTruthy();
    expect(Array.from(switcher.options).map(option => option.textContent?.trim())).toEqual(['New sidechat', 'Chat s1']);
    switcher.value = 's1';
    switcher.dispatchEvent(new Event('change'));
    await settle();
    expect(fixture.componentInstance.sideChatId()).toBe('s1');
    expect(el().querySelector('.sidechat-switcher')).toBeNull();

    el().querySelector<HTMLButtonElement>('[aria-label="New sidechat"]')!.click();
    await settle();
    expect(el().querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('unsent second question');
    expect(ipc['sideChatCreate']).not.toHaveBeenCalled();
    expect(ipc['sideChatSend']).not.toHaveBeenCalled();
  });

  it('requires a visible deletion confirmation and cancellation keeps the sidechat', async () => {
    lists.set('thread-a', [summary('s1', PARENT_A, 0, 0)]);
    setDetail('s1', []);
    fixture.componentRef.setInput('parent', PARENT_A);
    await settle();

    el().querySelector<HTMLButtonElement>('.discard-action')!.click();
    const confirmation = TestBed.inject(ConfirmService);
    expect(confirmation.pending()?.message).toContain('stops its answer and permanently deletes its conversation');
    expect(ipc['sideChatDiscard']).not.toHaveBeenCalled();
    confirmation.resolve(false);
    await settle();
    expect(fixture.componentInstance.sideChatId()).toBe('s1');
    expect(ipc['sideChatDiscard']).not.toHaveBeenCalled();

    el().querySelector<HTMLButtonElement>('.discard-action')!.click();
    lists.set('thread-a', []);
    confirmation.resolve(true);
    await settle();
    expect(ipc['sideChatDiscard']).toHaveBeenCalledWith({ chatId: 's1', confirmation: 'discard' });
    expect(fixture.componentInstance.sideChatId()).toBeNull();
  });

  it('does not send another question while a discard is waiting for confirmation', async () => {
    lists.set('thread-a', [summary('s1', PARENT_A, 0, 0)]);
    setDetail('s1', []);
    fixture.componentRef.setInput('parent', PARENT_A);
    await settle();
    TestBed.inject(SideChatStore).setDraft(PARENT_A, 's1', 'another question');
    el().querySelector<HTMLButtonElement>('.discard-action')!.click();

    await fixture.componentInstance.send();

    expect(ipc['sideChatSend']).not.toHaveBeenCalled();
    TestBed.inject(ConfirmService).resolve(false);
    await settle();
  });

  it('keeps permission diagnostics in closed Details and retries reading the parent permissions', async () => {
    ipc['sideChatPermissions'].mockResolvedValueOnce({
      success: true,
      data: { ok: false, code: 'unavailable-permissions', error: 'INTERNAL_POLICY_DIAGNOSTIC', providers: [] },
    });
    fixture.componentRef.setInput('parent', PARENT_A);
    await settle();

    const banner = el().querySelector<HTMLElement>('.error-banner')!;
    const details = banner.querySelector<HTMLDetailsElement>('details');
    expect(details).toBeTruthy();
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain('INTERNAL_POLICY_DIAGNOSTIC');
    const visibleNotice = banner.cloneNode(true) as HTMLElement;
    visibleNotice.querySelector('details')?.remove();
    expect(visibleNotice.textContent).toContain('Permissions unavailable');
    expect(visibleNotice.textContent).not.toContain('INTERNAL_POLICY_DIAGNOSTIC');

    banner.querySelector<HTMLButtonElement>('button')!.click();
    await settle();

    expect(ipc['sideChatPermissions']).toHaveBeenCalledTimes(2);
    expect(el().querySelector('.error-banner')).toBeNull();
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
    expect(fixture.componentInstance.summaries().map(summary => summary.chat.id)).toEqual(['b1']);
    expect(el().querySelector('.sidechat-switcher')).toBeNull();
    expect(store.draftFor(PARENT_A, 'a1')).toBe('draft for a1');
  });

  it('labels conversation states in text, not colour alone', async () => {
    lists.set('thread-a', [summary('s1', PARENT_A, 0, 4), summary('s2', PARENT_A, 0, 0)]);
    fixture.componentRef.setInput('parent', PARENT_A);
    fixture.componentInstance.selectSideChat('s2');
    await settle();

    const options = Array.from(el().querySelectorAll('option')).map(option => option.textContent?.trim());
    expect(options).toContain('Chat s1 · New answer');
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

  it('closes the panel without discarding its conversation', async () => {
    lists.set('thread-a', [summary('s1', PARENT_A, 0, 0)]);
    setDetail('s1', []);
    fixture.componentRef.setInput('parent', PARENT_A);
    await settle();
    const closed = vi.fn();
    fixture.componentInstance.closeRequested.subscribe(closed);

    el().querySelector<HTMLButtonElement>('.header-close')!.click();
    expect(closed).toHaveBeenCalled();
    expect(ipc['sideChatDiscard']).not.toHaveBeenCalled();
    expect(TestBed.inject(InstanceStore).interruptInstance).not.toHaveBeenCalled();
  });

  it('stops only the sidechat through a short visible label and locks its model picker', async () => {
    lists.set('thread-a', [summary('s1', PARENT_A, 0, 0)]);
    setDetail('s1', []);
    vi.mocked(TestBed.inject(InstanceStore).getInstance).mockReturnValue({
      id: 'side-runtime', displayName: 'Example sidechat', createdAt: 1, historyThreadId: 'example',
      parentId: null, childrenIds: [], agentId: 'build', agentMode: 'build', provider: 'claude', status: 'busy',
      contextUsage: { used: 0, total: 200000, percentage: 0 }, lastActivity: 1,
      providerSessionId: 'example-provider-session', sessionId: 'example-session', restartEpoch: 0,
      workingDirectory: '/example', yoloMode: false, launchMode: 'interactive', outputBuffer: [],
    });
    details.update(map => new Map(map).set('s1', {
      ...map.get('s1')!,
      chat: { ...map.get('s1')!.chat, currentInstanceId: 'side-runtime' },
    }));
    fixture.componentRef.setInput('parent', PARENT_A);
    await settle();
    const stop = el().querySelector<HTMLButtonElement>('.composer-button.stop');
    expect(stop?.textContent?.trim()).toBe('Stop sidechat');
    const picker = fixture.debugElement.query(By.directive(PickerStub)).componentInstance as PickerStub;
    expect(picker.disabledReason()).toContain('Stop the current answer');
    expect(el().querySelectorAll('[title]')).toHaveLength(0);
    stop!.click();
    expect(TestBed.inject(InstanceStore).interruptInstance).toHaveBeenCalledExactlyOnceWith('side-runtime');
  });

  it('opens the close reassurance and live shortcut on keyboard focus', async () => {
    await settle();
    const debug = fixture.debugElement.query(By.css('.header-close'));
    const directive = debug.injector.get(AioTooltipDirective, null);
    expect(directive?.appTooltipShortcut()).toBe('toggle-side-chat');
    const button: HTMLButtonElement = debug.nativeElement;
    expect(button.getAttribute('aria-label')).toBe('Close panel. Running sidechats keep going.');
    const matches = button.matches.bind(button);
    vi.spyOn(button, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    button.dispatchEvent(new FocusEvent('focus'));
    fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Running sidechats keep going.');
    expect(document.querySelector('[role="tooltip"] kbd')?.textContent).toBe('Ctrl+Alt+S');
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

  describe('when the sidechat\'s own session is waiting on a question', () => {
    const RUNTIME_ID = 'inst-side';
    let store: SideChatStore;

    /** s1 is open and its live session is the one the question card is shown for. */
    async function openWithLiveSession(): Promise<void> {
      lists.set('thread-a', [summary('s1', PARENT_A, 0, 0)]);
      details.update((map) => new Map(map).set('s1', {
        chat: { ...chat('s1'), currentInstanceId: RUNTIME_ID },
        conversation: { thread: {} as ChatDetail['conversation']['thread'], messages: [] },
        currentInstance: null,
      }));
      vi.mocked(TestBed.inject(InstanceStore).getInstance).mockReturnValue(
        { id: RUNTIME_ID, status: 'waiting_for_input', outputBuffer: [] } as unknown as Instance);
      fixture.componentRef.setInput('parent', PARENT_A);
      await settle();
      expect(fixture.componentInstance.sideChatId()).toBe('s1');
    }

    function question(
      result: QuestionOfferResult | Promise<QuestionOfferResult>,
      instanceId = RUNTIME_ID,
      requestId = 'q1',
    ) {
      const handle = { requestId, instanceId, createdAt: 1, answer: vi.fn(async () => result) };
      TestBed.inject(UserInputRequestRegistry).replace(`test ${requestId}`, [handle]);
      return handle;
    }

    beforeEach(async () => {
      store = TestBed.inject(SideChatStore);
      await openWithLiveSession();
    });

    it('gives the typed text to the question instead of asking a new one', async () => {
      const card = question('answered');
      store.setDraft(PARENT_A, 's1', 'Bun');

      await fixture.componentInstance.send();

      expect(card.answer).toHaveBeenCalledWith('Bun');
      expect(ipc['sideChatSend']).not.toHaveBeenCalled();
      expect(store.draftFor(PARENT_A, 's1')).toBe('');
    });

    it('answers when Enter is pressed in the message box', async () => {
      const card = question('answered');
      const textarea = el().querySelector<HTMLTextAreaElement>('textarea')!;
      textarea.value = 'Bun';
      textarea.dispatchEvent(new Event('input'));

      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
      await settle();

      expect(card.answer).toHaveBeenCalledWith('Bun');
      expect(ipc['sideChatSend']).not.toHaveBeenCalled();
      expect(textarea.value).toBe('');
    });

    it('clears the box when a card with several questions took the text but wants more', async () => {
      question('partial');
      store.setDraft(PARENT_A, 's1', 'first answer');

      await fixture.componentInstance.send();

      expect(ipc['sideChatSend']).not.toHaveBeenCalled();
      expect(store.draftFor(PARENT_A, 's1')).toBe('');
    });

    it('keeps the typed text when the answer could not be delivered', async () => {
      question('failed');
      store.setDraft(PARENT_A, 's1', 'Bun');

      await fixture.componentInstance.send();

      expect(ipc['sideChatSend']).not.toHaveBeenCalled();
      expect(store.draftFor(PARENT_A, 's1')).toBe('Bun');
    });

    it('keeps the typed text and sends nothing while an earlier answer is still on its way', async () => {
      question('busy');
      store.setDraft(PARENT_A, 's1', 'Bun');

      await fixture.componentInstance.send();

      expect(ipc['sideChatSend']).not.toHaveBeenCalled();
      expect(store.draftFor(PARENT_A, 's1')).toBe('Bun');
    });

    it('asks the sidechat normally when the question has already gone', async () => {
      question('not-applicable');
      store.setDraft(PARENT_A, 's1', 'Status?');

      await fixture.componentInstance.send();

      expect(ipc['sideChatSend']).toHaveBeenCalledWith({ chatId: 's1', text: 'Status?' });
    });

    it('asks the sidechat normally when no question is waiting, as with a permission card', async () => {
      store.setDraft(PARENT_A, 's1', 'Status?');

      await fixture.componentInstance.send();

      expect(ipc['sideChatSend']).toHaveBeenCalledWith({ chatId: 's1', text: 'Status?' });
    });

    it('ignores a question that belongs to another session', async () => {
      const other = question('answered', 'inst-elsewhere');
      store.setDraft(PARENT_A, 's1', 'Status?');

      await fixture.componentInstance.send();

      expect(other.answer).not.toHaveBeenCalled();
      expect(ipc['sideChatSend']).toHaveBeenCalledWith({ chatId: 's1', text: 'Status?' });
    });

    it('treats "Send with the last saved context" as a send, never as an answer', async () => {
      ipc['sideChatSend'].mockResolvedValueOnce({
        success: false,
        error: { message: 'Parent session is gone' },
        data: { ok: false, code: 'parent-unavailable', lastSnapshotAvailable: true },
      });
      store.setDraft(PARENT_A, 's1', 'Status?');
      await fixture.componentInstance.send();
      const card = question('answered');

      await fixture.componentInstance.send({ allowStaleContext: true });

      expect(card.answer).not.toHaveBeenCalled();
      expect(ipc['sideChatSend']).toHaveBeenLastCalledWith({ chatId: 's1', text: 'Status?', allowStaleContext: true });
    });

    it('clears only the draft the answer came from if the person switched sidechats meanwhile', async () => {
      lists.set('thread-a', [summary('s1', PARENT_A, 0, 0), summary('s2', PARENT_A, 0, 0)]);
      await store.refresh(PARENT_A);
      let deliver!: (result: QuestionOfferResult) => void;
      const card = question(new Promise<QuestionOfferResult>((resolveAnswer) => { deliver = resolveAnswer; }));
      store.setDraft(PARENT_A, 's1', 'Bun');

      const sending = fixture.componentInstance.send();
      fixture.componentInstance.selectSideChat('s2');
      store.setDraft(PARENT_A, 's2', 'Bun');
      deliver('answered');
      await sending;

      expect(card.answer).toHaveBeenCalledWith('Bun');
      expect(store.draftFor(PARENT_A, 's1')).toBe('');
      expect(store.draftFor(PARENT_A, 's2')).toBe('Bun');
    });
  });
});
