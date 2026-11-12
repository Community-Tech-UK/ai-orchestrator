import { By } from '@angular/platform-browser';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { PaletteOverlaysService } from '../commands/palette-overlays.service';
import { CUSTOM_ELEMENTS_SCHEMA, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { NgTemplateOutlet } from '@angular/common';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatDetail, ChatRecord } from '../../../../shared/types/chat.types';
import type { ConversationData, ConversationHistoryEntry } from '../../../../shared/types/history.types';
import type { SideChatParentRef, SideChatSummary } from '../../../../shared/types/side-chat.types';
import { ChatIpcService } from '../../core/services/ipc/chat-ipc.service';
import { SideChatPanelComponent } from '../side-chat/side-chat-panel.component';
import type { UiActionRegistration } from '../../core/services/action-dispatch.service';
import { ActionDispatchService } from '../../core/services/action-dispatch.service';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { KeybindingService } from '../../core/services/keybinding.service';
import { ModelPickerFocusService } from '../models/model-picker-focus.service';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { ComposerFocusService } from '../../core/services/composer-focus.service';
import { ScratchDirectoryService } from '../../core/services/scratch-directory.service';
import { ViewLayoutService, type WorkspacePreset } from '../../core/services/view-layout.service';
import { VisibleInstanceResolver } from '../../core/services/visible-instance-resolver.service';
import { ChatStore } from '../../core/state/chat.store';
import { SideChatStore } from '../../core/state/side-chat.store';
import { CliStore } from '../../core/state/cli.store';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { SettingsStore } from '../../core/state/settings.store';
import { SourceControlStore } from '../../core/state/source-control.store';
import { SessionRecoveryStore } from '../../core/state/session-recovery.store';
import { SessionRecoveryBannerComponent } from '../../shared/components/session-recovery-banner/session-recovery-banner.component';
import { ResumePickerController } from '../resume/resume-picker.controller';
import { DashboardComponent } from './dashboard.component';
import { FeatureUsageService } from '../../shared/tips/feature-usage.service';

const directory = dirname(fileURLToPath(import.meta.url));
const dashboardTemplate = readFileSync(resolve(directory, './dashboard.component.html'), 'utf8');
const recoveryTemplate = readFileSync(resolve(directory, '../../shared/components/session-recovery-banner/session-recovery-banner.component.html'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('dashboard.component.html')) return Promise.resolve(dashboardTemplate);
  if (url.endsWith('session-recovery-banner.component.html')) return Promise.resolve(recoveryTemplate);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('DashboardComponent', () => {
  const selectedInstance = signal<unknown | null>(null);
  const instances = signal<unknown[]>([]);
  const previewConversation = signal<unknown | null>(null);
  const selectedChatId = signal<string | null>(null);
  const selectedChat = signal<Partial<ChatRecord> | null>(null);
  const historyEntries = signal<ConversationHistoryEntry[]>([]);
  const chatDetails = signal(new Map<string, ChatDetail>());
  const effectiveSidebarStyle = signal('comfortable');
  const defaultSettings = signal({ defaultWorkingDirectory: null as string | null });
  const draftWorkingDirectory = signal<string | null>(null);
  const draftNodeId = signal<string | null>(null);
  const activePreset = signal(null);
  const controlPlanePinned = signal(false);
  const totalChangeCount = signal(0);
  const registeredActions: UiActionRegistration[] = [];
  const recoveryCandidates = signal([{ recoveryKey: 'recovery-1', sourceInstanceId: 'source-1',
    displayName: 'Autosaved session', recoveredMessageCount: 2, reason: 'unarchived' as const,
    lastActivityAt: 1 }]);
  const sideChatOpenRequest = signal<{ parent: unknown; chatId: string | null; id: number } | null>(null);
  const sideChatStore = { initialize: vi.fn(), openRequest: sideChatOpenRequest.asReadonly() };
  const resumePickerController = {
    focusRecoveryContent: vi.fn(),
    resetTransientFocus: vi.fn(),
    ensureCandidatesLoaded: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    selectedInstance.set(null);
    instances.set([]);
    previewConversation.set(null);
    selectedChatId.set(null);
    selectedChat.set(null);
    historyEntries.set([]);
    chatDetails.set(new Map());
    draftWorkingDirectory.set(null);
    draftNodeId.set(null);
    registeredActions.length = 0;
    sideChatOpenRequest.set(null);

    TestBed.overrideComponent(DashboardComponent, {
      set: {
        imports: [NgTemplateOutlet, SessionRecoveryBannerComponent, AioTooltipDirective],
        template: dashboardTemplate,
        templateUrl: undefined,
        styles: [],
        styleUrl: undefined,
        styleUrls: [],
        schemas: [CUSTOM_ELEMENTS_SCHEMA],
      },
    });

    TestBed.configureTestingModule({
      providers: [
        { provide: PaletteOverlaysService, useValue: { commandPaletteOpen: signal(false), commandHelpOpen: signal(false) } },
        { provide: Router, useValue: { navigate: vi.fn().mockResolvedValue(true) } },
        {
          provide: InstanceStore,
          useValue: {
            selectedInstance: selectedInstance.asReadonly(),
            instances: instances.asReadonly(),
            setSelectedInstance: vi.fn((id: string | null) => selectedInstance.set(instances().find((item) => (item as { id: string }).id === id) ?? null)),
            getInstance: vi.fn(() => null),
            instanceActivities: signal(new Map()),
            createInstance: vi.fn(),
            sendInput: vi.fn(),
            terminateInstance: vi.fn(),
            terminateAllInstances: vi.fn(),
            restartInstance: vi.fn(),
            interruptInstance: vi.fn().mockResolvedValue(true),
          },
        },
        {
          provide: HistoryStore,
          useValue: {
            entries: historyEntries.asReadonly(),
            previewConversation: previewConversation.asReadonly(),
            clearSelection: vi.fn(() => previewConversation.set(null)),
            restoreEntry: vi.fn(),
            loadHistory: vi.fn(async () => undefined),
          },
        },
        {
          provide: CliStore,
          useValue: {
            initialize: vi.fn(),
            refresh: vi.fn(),
            loading: signal(false),
            noClisError: signal(null),
          },
        },
        {
          provide: SettingsStore,
          useValue: {
            initialize: vi.fn().mockResolvedValue(undefined),
            effectiveSidebarStyle: effectiveSidebarStyle.asReadonly(),
            settings: defaultSettings.asReadonly(),
            showThinking: signal(false),
            thinkingDefaultExpanded: signal(false),
            showToolMessages: signal(false),
          },
        },
        {
          provide: ChatStore,
          useValue: {
            selectedChatId: selectedChatId.asReadonly(),
            selectedChat: selectedChat.asReadonly(),
            deselect: vi.fn(() => { selectedChatId.set(null); selectedChat.set(null); }),
            details: chatDetails.asReadonly(),
            chats: signal<ChatRecord[]>([]),
            ensureDetailLoaded: vi.fn().mockResolvedValue(undefined),
            sendMessageTo: vi.fn(),
            selectFirstChat: vi.fn(),
            select: vi.fn().mockResolvedValue(undefined),
          },
        },
        { provide: RemoteNodeStore, useValue: { initialize: vi.fn() } },
        { provide: SideChatStore, useValue: sideChatStore },
        { provide: ElectronIpcService, useValue: { isElectron: true } },
        {
          provide: ActionDispatchService,
          useValue: {
            register: vi.fn((action: UiActionRegistration) => {
              registeredActions.push(action);
              return vi.fn();
            }),
          },
        },
        { provide: KeybindingService, useValue: { setEligibilityState: vi.fn(), ariaShortcutsByAction: () => 'Control+B', formatBindingByAction: () => 'Ctrl+B' } },
        {
          provide: ViewLayoutService,
          useValue: {
            sidebarWidth: 320,
            sideChatWidth: 360,
            presets: [] satisfies WorkspacePreset[],
            activePreset: activePreset.asReadonly(),
            controlPlanePinned: controlPlanePinned.asReadonly(),
            setSidebarWidth: vi.fn(),
            setActivePreset: vi.fn(),
            setControlPlanePinned: vi.fn(),
            getPreset: vi.fn(),
          },
        },
        {
          provide: NewSessionDraftService,
          useValue: {
            workingDirectory: draftWorkingDirectory.asReadonly(),
            nodeId: draftNodeId.asReadonly(),
            open: vi.fn(),
          },
        },
        {
          provide: ScratchDirectoryService,
          useValue: {
            dir: signal<string | null>(null).asReadonly(),
            init: vi.fn().mockResolvedValue(undefined),
            isScratch: vi.fn(() => false),
          },
        },
        { provide: VisibleInstanceResolver, useValue: { selectVisibleInstance: vi.fn() } },
        { provide: ModelPickerFocusService, useValue: { requestOpen: vi.fn() } },
        { provide: ResumePickerController, useValue: resumePickerController },
        { provide: SessionRecoveryStore, useValue: {
          candidates: recoveryCandidates.asReadonly(), loading: signal(false), error: signal(null),
          refresh: vi.fn(async () => undefined),
        } },
        {
          provide: SourceControlStore,
          useValue: {
            totalChangeCount: totalChangeCount.asReadonly(),
            loadForRoot: vi.fn().mockResolvedValue(undefined),
          },
        },
      ],
    });
  });

  it('keeps distinct pin hints and supplies the sidebar shortcut through a real directive', () => {
    const fixture = TestBed.createComponent(DashboardComponent);
    fixture.componentInstance.showSidebar.set(false); fixture.componentInstance.showControlPlane.set(true); fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('[title]')).toHaveLength(0);
    const sidebar = fixture.debugElement.query(By.css('.sidebar-toggle-btn'));
    expect(sidebar.injector.get(AioTooltipDirective).appTooltip()).toBe('Show sidebar');
    expect(sidebar.injector.get(AioTooltipDirective).appTooltipShortcut()).toBe('toggle-sidebar');
    const pin = fixture.debugElement.query(By.css('.control-plane-pin'));
    expect(pin.nativeElement.getAttribute('aria-label')).toBe('Pin control plane');
    expect(pin.injector.get(AioTooltipDirective).appTooltip()).toBe('Pin — dock the control plane');
    controlPlanePinned.set(true); fixture.detectChanges();
    const unpin = fixture.debugElement.query(By.css('.control-plane-pin'));
    expect(unpin.injector.get(AioTooltipDirective).appTooltip()).toBe('Unpin — float the control plane');
    controlPlanePinned.set(false);
    fixture.destroy();
  });
  it('returns focus to the migrated sidechat rail toggle on close', async () => {
    const component = TestBed.runInInjectionContext(() => new DashboardComponent());
    const rail = document.createElement('app-workspace-rail');
    rail.innerHTML = '<button data-testid="sidechat-toggle" aria-label="Sidechats"></button>';
    document.body.appendChild(rail);
    try {
      component.showSideChat.set(true); component.closeSideChat(); await Promise.resolve();
      expect(document.activeElement).toBe(rail.querySelector('button'));
    } finally { rail.remove(); component.ngOnDestroy(); }
  });

  it('leaves global navigation and palette actions owned by the root service', () => {
    const component = TestBed.runInInjectionContext(() => new DashboardComponent());
    component.ngOnInit();
    const ids = registeredActions.map(action => action.id);
    for (const id of ['toggle-command-palette', 'app.open-command-help', 'toggle-settings',
      'app.open-rlm', 'app.open-browser', 'app.open-doctor']) expect(ids).not.toContain(id);
    expect(dashboardTemplate).not.toContain('<app-command-palette');
    component.ngOnDestroy();
  });

  it('keeps banner-open recovery filtering scoped to the current picker lifetime', () => {
    const component = TestBed.runInInjectionContext(() => new DashboardComponent());

    component.openRecoveryPicker();
    expect(resumePickerController.focusRecoveryContent).toHaveBeenCalledOnce();
    expect(resumePickerController.resetTransientFocus).not.toHaveBeenCalled();
    expect(component.showResumePicker()).toBe(true);

    component.closeResumePicker();
    expect(resumePickerController.resetTransientFocus).toHaveBeenCalledOnce();
    expect(component.showResumePicker()).toBe(false);

    component.openResumePicker();
    expect(resumePickerController.resetTransientFocus).toHaveBeenCalledTimes(2);
    expect(component.showResumePicker()).toBe(true);

    component.ngOnDestroy();
  });

  it('starts the explicit Quick chat in scratch even with a project selected', async () => {
    selectedInstance.set({ id: 'selected', workingDirectory: '/project', executionLocation: { type: 'local' } });
    TestBed.overrideProvider(ScratchDirectoryService, { useValue: { init: async () => undefined, dir: () => '/scratch', isScratch: (path: string) => path === '/scratch' } });
    const component = TestBed.runInInjectionContext(() => new DashboardComponent());
    await component.createGeneralChat(true);
    expect(TestBed.inject(NewSessionDraftService).open).toHaveBeenCalledWith('/scratch', null, { hintWorkspace: false });
    expect(TestBed.inject(ComposerFocusService).pending()).toEqual({ target: 'new' });
    component.ngOnDestroy();
  });

  it('routes the resume.openPicker keybinding through the normal unfiltered open path', () => {
    const component = TestBed.runInInjectionContext(() => new DashboardComponent());

    component.ngOnInit();
    expect(resumePickerController.ensureCandidatesLoaded).toHaveBeenCalledOnce();
    const openResume = registeredActions.find((action) => action.id === 'resume.openPicker');
    expect(openResume).toBeDefined();

    component.openRecoveryPicker();
    openResume?.run();

    expect(resumePickerController.focusRecoveryContent).toHaveBeenCalledOnce();
    expect(resumePickerController.resetTransientFocus).toHaveBeenCalledOnce();
    expect(component.showResumePicker()).toBe(true);

    component.ngOnDestroy();
  });

  it('renders the startup recovery notice and opens the recovery picker from its action', async () => {
    const fixture = TestBed.createComponent(DashboardComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const banner = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-testid="session-recovery-banner"]');
    expect(banner?.textContent).toContain('Autosaved session');
    banner?.querySelector<HTMLButtonElement>('button')?.click();
    expect(fixture.componentInstance.showResumePicker()).toBe(true);
    fixture.destroy();
  });

  it('opens a badge\'s exact sidechat on its live parent session', () => {
    instances.set([{ id: 'live-1', historyThreadId: 'thread-1', status: 'busy' }]);
    const fixture = TestBed.createComponent(DashboardComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    sideChatOpenRequest.set({
      parent: { kind: 'session', historyThreadId: 'thread-1', originNodeId: null }, chatId: 'side-7', id: 1,
    });
    fixture.detectChanges();

    expect(TestBed.inject(InstanceStore).setSelectedInstance).toHaveBeenCalledWith('live-1');
    expect(component.showSideChat()).toBe(true);
    expect(component.sideChatPreferredChatId()).toBe('side-7');
    expect(sideChatStore.initialize).toHaveBeenCalled();
    fixture.destroy();
  });

  it('records the side-chat feature when the rail opens it and does not record a close', () => {
    localStorage.removeItem('working-tips:v1');
    const component = TestBed.runInInjectionContext(() => new DashboardComponent());
    const usage = TestBed.inject(FeatureUsageService);
    component.toggleSideChat(); expect(usage.count('toggle-side-chat')).toBe(1);
    component.toggleSideChat(); expect(usage.count('toggle-side-chat')).toBe(1);
    component.ngOnDestroy();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const archivedParent: SideChatParentRef = {
    kind: 'session', historyThreadId: 'archived-thread', originNodeId: 'archive-node',
  };
  const archivedEntry: ConversationHistoryEntry = {
    id: 'archive-entry', historyThreadId: 'archived-thread', displayName: 'Archived investigation',
    workingDirectory: '/tmp/archived-project', provider: 'codex', currentModel: 'model-a',
    createdAt: 1, endedAt: 2, messageCount: 2, firstUserMessage: 'Investigate', lastUserMessage: 'Investigate',
    status: 'terminated', originalInstanceId: 'old-runtime', parentId: null, sessionId: 'native-session',
    executionLocation: { type: 'remote', nodeId: 'archive-node' },
  };

  function archivedPanel(attentionTitle: string | null = null) {
    historyEntries.set([{ ...archivedEntry, id: 'decoy', historyThreadId: 'native-session', displayName: 'Wrong same-project session' }, archivedEntry]);
    const chat: ChatRecord = {
      id: 'exact-archived-sidechat', name: 'Archived answer', provider: 'codex', model: null,
      reasoningEffort: null, currentCwd: '/tmp/archived-project', projectId: null, yolo: false,
      ledgerThreadId: 'side-thread', currentInstanceId: null, createdAt: 1, lastActiveAt: 2, archivedAt: null,
    };
    const summary: SideChatSummary = {
      chat, link: { chatId: chat.id, parent: archivedParent, authority: 'inherit-parent', lastReadAssistantSequence: 0 },
      status: null, latestAssistantSequence: 4, state: 'unread',
    };
    chatDetails.set(new Map([[chat.id, {
      chat, currentInstance: null, conversation: {
        thread: { id: 'side-thread' } as ChatDetail['conversation']['thread'],
        messages: [{
          id: 'answer', threadId: 'side-thread', sequence: 4, role: 'assistant', content: 'Saved answer',
          nativeMessageId: null, nativeTurnId: null, phase: null, createdAt: 2,
          tokenInput: null, tokenOutput: null, rawRef: null, rawJson: null, sourceChecksum: null,
        }],
      },
    }]]));
    const ipc = {
      onChatEvent: vi.fn(() => () => undefined),
      sideChatAttentionAll: vi.fn().mockResolvedValue({ success: true, data: attentionTitle ? [{
        parent: archivedParent, parentTitle: attentionTitle, total: 1,
        unread: 1, needsAttention: 0, running: 0, targetChatId: 'exact-archived-sidechat',
      }] : [] }),
      sideChatList: vi.fn(async ({ parent }: { parent: SideChatParentRef }) => ({
        success: true, data: { active: parent.kind === 'session' && parent.historyThreadId === 'archived-thread' ? [summary] : [], archived: [] },
      })),
      sideChatPermissions: vi.fn().mockResolvedValue({ success: false }),
      sideChatCreate: vi.fn(), sideChatSend: vi.fn(),
      sideChatMarkRead: vi.fn(async ({ throughSequence }: { throughSequence: number }) => ({
        success: true, data: { ...summary.link, lastReadAssistantSequence: throughSequence },
      })),
    };
    TestBed.overrideProvider(SideChatStore, { useFactory: () => new SideChatStore() });
    TestBed.configureTestingModule({ providers: [{ provide: ChatIpcService, useValue: ipc }] });
    TestBed.overrideComponent(DashboardComponent, {
      set: { imports: [NgTemplateOutlet, SessionRecoveryBannerComponent, SideChatPanelComponent] },
    });
    // Keep the real panel effects/read acknowledgement; replace only its heavy
    // children with a transcript viewport whose scroll position we control.
    TestBed.overrideComponent(SideChatPanelComponent, {
      set: { imports: [], templateUrl: undefined, styleUrl: undefined, styles: [], styleUrls: [],
        template: '<h2>{{ parentTitle() }}</h2><div class="panel-body"><div class="output-stream"></div></div>' },
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const fixture = TestBed.createComponent(DashboardComponent);
    const store = TestBed.inject(SideChatStore);
    async function settle() {
      for (let i = 0; i < 4; i += 1) {
        fixture.detectChanges();
        await new Promise((resolveTick) => setTimeout(resolveTick, 0));
        await fixture.whenStable();
      }
      fixture.detectChanges();
    }
    function panel(): SideChatPanelComponent {
      const host = fixture.debugElement.query(By.directive(SideChatPanelComponent));
      expect(host, 'archived requests must render the read-aware sidechat panel').toBeTruthy();
      return host.componentInstance as SideChatPanelComponent;
    }
    return { fixture, store, ipc, settle, panel };
  }

  it('opens the exact archived sidechat in its parent panel and acknowledges only a focused, scrolled answer', async () => {
    instances.set([
      { id: 'other-runtime', historyThreadId: 'other-thread', workingDirectory: '/tmp/archived-project', status: 'idle' },
      { id: 'old-runtime', historyThreadId: 'archived-thread', status: 'terminated' },
    ]);
    selectedInstance.set(instances()[0]);
    const { fixture, store, ipc, settle, panel } = archivedPanel();
    store.requestOpen(archivedParent, 'exact-archived-sidechat');
    await settle();

    expect(panel().parent()).toEqual(archivedParent);
    expect(panel().parentTitle()).toBe('Archived investigation');
    expect(panel().workingDirectory()).toBe('/tmp/archived-project');
    expect(panel().parentSelection()).toMatchObject({ provider: 'codex', model: 'model-a' });
    expect(panel().sideChatId()).toBe('exact-archived-sidechat');
    expect(ipc.sideChatList).toHaveBeenCalledWith({ parent: archivedParent });
    expect(TestBed.inject(ChatStore).select).not.toHaveBeenCalled();
    expect(TestBed.inject(HistoryStore).restoreEntry).not.toHaveBeenCalled();
    expect(TestBed.inject(InstanceStore).setSelectedInstance).toHaveBeenCalledExactlyOnceWith(null);
    expect(TestBed.inject(InstanceStore).createInstance).not.toHaveBeenCalled();
    expect(TestBed.inject(InstanceStore).restartInstance).not.toHaveBeenCalled();
    expect(TestBed.inject(InstanceStore).sendInput).not.toHaveBeenCalled();
    expect(TestBed.inject(ChatStore).sendMessageTo).not.toHaveBeenCalled();
    expect(ipc.sideChatCreate).not.toHaveBeenCalled();
    expect(ipc.sideChatSend).not.toHaveBeenCalled();
    expect(ipc.sideChatMarkRead).not.toHaveBeenCalled();

    vi.mocked(document.hasFocus).mockReturnValue(true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const viewport = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.output-stream')!;
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 200 });
    viewport.scrollTop = 100;
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(ipc.sideChatMarkRead).not.toHaveBeenCalled();

    viewport.scrollTop = 800;
    viewport.dispatchEvent(new Event('scroll'));
    await settle();
    expect(ipc.sideChatMarkRead).toHaveBeenCalledExactlyOnceWith({ chatId: 'exact-archived-sidechat', throughSequence: 4 });
    expect(store.summariesFor(archivedParent)[0].state).toBe('idle');
    store.disposeForTesting();
    fixture.destroy();
  });

  it('lets an archived parent selector resolve an existing conversation without starting a runtime', async () => {
    const { fixture, store, ipc, settle, panel } = archivedPanel();
    store.requestOpen(archivedParent, null);
    await settle();
    expect(panel().sideChatId()).toBe('exact-archived-sidechat');
    expect(ipc.sideChatCreate).not.toHaveBeenCalled();
    expect(ipc.sideChatSend).not.toHaveBeenCalled();
    expect(TestBed.inject(HistoryStore).restoreEntry).not.toHaveBeenCalled();
    store.disposeForTesting();
    fixture.destroy();
  });

  it('uses matching history preview metadata before clearing the preview selection', async () => {
    const { fixture, store, settle, panel } = archivedPanel();
    previewConversation.set({
      entry: { ...archivedEntry, displayName: 'Preview title', workingDirectory: '/tmp/preview-project' }, messages: [],
    } satisfies ConversationData);
    store.requestOpen(archivedParent, 'exact-archived-sidechat');
    await settle();
    expect(panel().parent()).toEqual(archivedParent);
    expect(panel().parentTitle()).toBe('Preview title');
    expect(panel().workingDirectory()).toBe('/tmp/preview-project');
    expect(previewConversation()).toBeNull();
    store.disposeForTesting();
    fixture.destroy();
  });

  it('uses the existing attention title when an archived parent is outside loaded history', async () => {
    const { fixture, store, settle, panel } = archivedPanel('Older archived session');
    historyEntries.set([]);
    await settle();
    store.requestOpen(archivedParent, 'exact-archived-sidechat');
    await settle();
    expect(panel().parentTitle()).toBe('Older archived session');
    expect(panel().parent()).toEqual(archivedParent);
    expect(panel().workingDirectory()).toBeNull();
    store.disposeForTesting();
    fixture.destroy();
  });

  it.each(['session', 'chat', 'history', 'close', 'toggle', 'preset', 'main', 'live-request', 'chat-request'] as const)(
    'drops archived panel context after selecting %s', async (selection) => {
      const previousLive = { id: 'live-runtime', historyThreadId: 'live-thread', displayName: 'Live session', provider: 'claude', status: 'idle' };
      instances.set([previousLive]);
      selectedInstance.set(previousLive);
      const { fixture, store, settle, panel } = archivedPanel();
      store.requestOpen(archivedParent, 'exact-archived-sidechat');
      await settle();
      expect(panel().parent()).toEqual(archivedParent);

      if (selection === 'session') {
        // Reselecting the session shown before the archived badge must work too.
        TestBed.inject(InstanceStore).setSelectedInstance('live-runtime');
      } else if (selection === 'chat') {
        selectedChat.set({ id: 'main-chat', name: 'Main chat', provider: 'claude' });
        selectedChatId.set('main-chat');
      } else if (selection === 'history') {
        previewConversation.set({ entry: { id: 'other-entry', historyThreadId: 'other-archive' } });
      } else if (selection === 'live-request') {
        store.requestOpen({ kind: 'session', historyThreadId: 'live-thread', originNodeId: null }, 'live-sidechat');
      } else if (selection === 'chat-request') {
        vi.mocked(TestBed.inject(ChatStore).select).mockImplementation(async () => {
          selectedChat.set({ id: 'main-chat', name: 'Main chat', provider: 'claude' });
          selectedChatId.set('main-chat');
        });
        store.requestOpen({ kind: 'chat', chatId: 'main-chat' }, 'chat-sidechat');
      } else if (selection === 'preset') {
        vi.mocked(TestBed.inject(ViewLayoutService).getPreset).mockReturnValue({
          id: 'research', label: 'Research', description: '',
          panels: { sidebar: true, controlPlane: false, fileExplorer: false, sourceControl: false, sideChat: false },
        });
        fixture.componentInstance.applyWorkspacePreset('research');
      } else if (selection === 'main') {
        fixture.componentInstance.openSideChatInMain('exact-archived-sidechat');
      } else if (selection === 'close') {
        fixture.debugElement.query(By.directive(SideChatPanelComponent)).triggerEventHandler('closeRequested');
      } else {
        fixture.componentInstance.toggleSideChat();
      }
      await settle();
      if (!fixture.componentInstance.showSideChat()) {
        fixture.componentInstance.toggleSideChat();
        await settle();
      }
      const liveSession = selection === 'session' || selection === 'live-request';
      const mainChat = selection === 'chat' || selection === 'chat-request';
      expect(panel().parent()).toEqual(liveSession
        ? { kind: 'session', historyThreadId: 'live-thread', originNodeId: null }
        : mainChat ? { kind: 'chat', chatId: 'main-chat' } : null);
      expect(panel().parentTitle()).toBe(liveSession ? 'Live session' : mainChat ? 'Main chat' : '');
      expect(panel().preferredChatId()).toBe(selection === 'live-request' ? 'live-sidechat' : selection === 'chat-request' ? 'chat-sidechat' : null);
      expect(panel().sideChatId()).toBeNull();
      expect(panel().workingDirectory()).not.toBe('/tmp/archived-project');
      store.disposeForTesting();
      fixture.destroy();
    },
  );
});
