import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Component,
  input,
  signal,
  type Type,
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../../shared/types/settings.types';
import { ActionDispatchService } from '../../core/services/action-dispatch.service';
import { DraftService } from '../../core/services/draft.service';
import { AppIpcService } from '../../core/services/ipc/app-ipc.service';
import { CodebaseIpcService } from '../../core/services/ipc/codebase-ipc.service';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { OperatorIpcService } from '../../core/services/ipc/operator-ipc.service';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';
import { ProviderIpcService } from '../../core/services/ipc/provider-ipc.service';
import { IpcFacadeService, OrchestrationIpcService, RecentDirectoriesIpcService } from '../../core/services/ipc';
import { KeybindingService } from '../../core/services/keybinding.service';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { PerfInstrumentationService } from '../../core/services/perf-instrumentation.service';
import { PromptSuggestionService } from '../../core/services/prompt-suggestion.service';
import { ProviderStateService } from '../../core/services/provider-state.service';
import { ChatStore } from '../../core/state/chat.store';
import { CommandStore } from '../../core/state/command.store';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import { InstanceListStore } from '../../core/state/instance/instance-list.store';
import { InstanceMessagingStore } from '../../core/state/instance/instance-messaging.store';
import type { Instance } from '../../core/state/instance/instance.types';
import { LoopStore } from '../../core/state/loop.store';
import { PromptHistoryStore } from '../../core/state/prompt-history.store';
import { SettingsStore } from '../../core/state/settings.store';
import { TodoStore } from '../../core/state/todo.store';
import { VoiceConversationStore } from '../../core/voice/voice-conversation.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { AppIconButtonDirective } from '../../shared/tooltip/icon-button.directive';
import { ChatDetailComponent } from '../chats/chat-detail.component';
import { LoopPromptHistoryService } from '../loop/loop-prompt-history.service';
import { LoopStopConfirmService } from '../loop/loop-stop-confirm.service';
import { QuickActionDispatcherService } from '../orchestration/quick-action-dispatcher.service';
import { ColdCacheChipComponent } from './cold-cache-chip.component';
import { COLD_CACHE_IDLE_MS } from './cold-cache-resume';
import { ColdCacheResumeService } from './cold-cache-resume.service';
import { FileAttachmentService } from './file-attachment.service';
import { InputPanelComponent } from './input-panel.component';
import { InstanceDetailComponent } from './instance-detail.component';
import { WelcomeCoordinatorService } from './welcome-coordinator.service';

const dir = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(resolve(dir, relative), 'utf8');
// The REAL templates: which inputs each host binds on the composer is what is under test.
const inputPanelTemplate = read('./input-panel.component.html');
const chatDetailTemplate = read('../chats/chat-detail.component.html');
const instanceDetailTemplate = read('./instance-detail.component.html');

await resolveComponentResources((url) => {
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected component resource: ${url}`));
});

@Component({ selector: 'app-drop-zone', standalone: true, template: '<ng-content />' })
class DropZoneStubComponent {
  readonly pasteOwner = input<unknown>();
}

const coldSince = () => Date.now() - COLD_CACHE_IDLE_MS - 60_000;

/** A big Claude conversation that has been idle for over an hour: the service offers compact-first for it. */
function coldClaudeInstance(id: string): Instance {
  return {
    id, displayName: 'Session', createdAt: Date.now(), historyThreadId: 'thread-1', parentId: null,
    childrenIds: [], agentId: 'build', agentMode: 'build', provider: 'claude', status: 'idle',
    contextUsage: { used: 150_000, total: 200_000, percentage: 75, occupancyReported: true },
    lastActivity: Date.now(), sessionId: id, providerSessionId: 'provider-1', restartEpoch: 0,
    workingDirectory: '/tmp/project', yoloMode: false, launchMode: 'interactive', currentModel: undefined,
    outputBuffer: [{ id: 'a1', type: 'assistant', content: 'earlier answer', timestamp: coldSince() }],
  } as unknown as Instance;
}

/** Everything the REAL composer injects, shared by the three hosts below. */
function composerProviders(instance: Instance) {
  return [
    ColdCacheResumeService,
    DraftService,
    { provide: InstanceMessagingStore, useValue: { getQueuedMessageCount: () => 0 } },
    { provide: CommandStore, useValue: {
      loadCommands: vi.fn(), commands: signal([]), commandEligibility: vi.fn(() => ({ eligible: true })),
      getCommandByName: vi.fn(() => undefined), resolveCommand: vi.fn(), executeCommand: vi.fn(),
    } },
    { provide: PromptSuggestionService, useValue: { getSuggestion: vi.fn(() => null) } },
    { provide: PerfInstrumentationService, useValue: { markComposerLatency: vi.fn(() => vi.fn()) } },
    { provide: ProviderStateService, useValue: {
      selectedProvider: signal('claude'), selectedModel: signal(''), fastModeByProvider: signal({}),
      setProvider: vi.fn(), setModel: vi.fn(), getFastModeForProvider: vi.fn(() => false),
      rememberFastModeForProvider: vi.fn(), getLaunchModeForProvider: vi.fn(() => 'orchestrated'),
    } },
    { provide: NewSessionDraftService, useValue: {
      revision: signal(0), activeKey: signal('__default__'), prompt: signal(''), provider: signal(null),
      model: signal(null), modelRuntimeTarget: signal(null), reasoningEffort: signal(null), nodeId: signal(null),
      yoloMode: signal(null), hardened: signal(null), signalFenceOff: signal(false), launchMode: signal(null),
      agentId: signal('build'), accountProfileId: signal(null), setPrompt: vi.fn(), clearActiveComposer: vi.fn(),
      setWorkingDirectory: vi.fn(),
    } },
    { provide: ActionDispatchService, useValue: { dispatch: vi.fn() } },
    { provide: KeybindingService, useValue: { setContext: vi.fn(), onAction: vi.fn(() => vi.fn()),
          formatBindingByAction: () => 'Enter', ariaShortcutsByAction: () => 'Enter' } },
    { provide: OrchestrationIpcService, useValue: { workflowNlSuggest: vi.fn(async () => ({ success: false })) } },
    { provide: AppIpcService, useValue: { getStartupCapabilities: vi.fn(async () => null) } },
    { provide: ElectronIpcService, useValue: { platform: 'darwin', getApi: () => null } },
    { provide: PromptHistoryStore, useValue: {
      requestedRecallEntry: signal(null), getEntriesForRecall: vi.fn(() => []),
      clearRequestedRecallEntry: vi.fn(), record: vi.fn(),
    } },
    { provide: VoiceConversationStore, useValue: {
      mode: signal('off'), partialTranscript: signal(''), error: signal(null), errorCode: signal(null),
      transcriptDetached: signal(false), audioLevel: signal(0), updateContext: vi.fn(), stop: vi.fn(),
      detachTranscript: vi.fn(), start: vi.fn(), setTemporaryOpenAiKey: vi.fn(),
    } },
    { provide: CodebaseIpcService, useValue: { search: vi.fn() } },
    { provide: SettingsStore, useValue: {
      ...settingsStoreFields(),
      defaultYoloMode: signal(false),
      settings: signal({ ...DEFAULT_SETTINGS, providerSignalFenceEnabled: true, coldCacheCompactFirst: true }),
    } },
    { provide: InstanceStore, useValue: {
      getInstance: () => instance, isInstanceCompacting: () => false, isQueueParked: () => false,
      compactInstance: vi.fn(), instanceActivities: signal(new Map()), interruptInstance: vi.fn(),
      selectedInstance: signal<Instance | null>(instance),
      selectedInstanceIdentity: signal<string | null>(instance.id),
      selectedInstanceSessionId: signal<string | null>(instance.sessionId),
      selectedInstanceActivity: signal(null),
      getSelectedInstanceBusySince: vi.fn(() => null),
      sendInput: vi.fn(), setSelectedInstance: vi.fn(),
      getMessageQueue: vi.fn(() => []), getQueuedMessageCount: vi.fn(() => 0),
    } },
  ];
}

function settingsStoreFields() {
  return {
    isInitialized: signal(true), defaultWorkingDirectory: signal('/tmp/project'),
    showThinking: signal(true), thinkingDefaultExpanded: signal(false), showToolMessages: signal(true),
  };
}

const sendLabel = (host: HTMLElement) => host.querySelector('button.btn-send')?.getAttribute('aria-label');

describe('cold-cache chip and label are enabled by the host, not by the composer', () => {
  let fixture: ComponentFixture<unknown>;

  beforeEach(() => {
    // Child components other than the ones under test are intentionally not declared; Angular logs each as unknown.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    TestBed.resetTestingModule();
  });
  afterEach(() => {
    fixture?.destroy();
    vi.restoreAllMocks();
  });

  async function configure<T>(host: Type<T>, template: string, imports: unknown[], instance: Instance, extra: unknown[] = []) {
    TestBed.overrideComponent(InputPanelComponent, {
      set: {
        template: inputPanelTemplate, templateUrl: undefined, styles: [], styleUrl: undefined, styleUrls: [],
        imports: [AppIconButtonDirective, AioTooltipDirective, ColdCacheChipComponent],
      },
    });
    TestBed.overrideComponent(host, {
      set: { template, templateUrl: undefined, styles: [], styleUrl: undefined, styleUrls: [], imports: imports as never[] },
    });
    await TestBed.configureTestingModule({ imports: [host], providers: [...composerProviders(instance), ...extra] })
      .compileComponents();
  }

  describe('Chat host (chat-detail template, real composer)', () => {
    it('shows no chip and keeps the plain Send label for a cold Claude chat, because Chat never compacts first', async () => {
      const instance = coldClaudeInstance('chat-instance-1');
      const chat = {
        id: 'chat-1', name: 'My chat', provider: 'claude', model: null, reasoningEffort: null, currentCwd: '/tmp/project',
        projectId: null, yolo: false, ledgerThreadId: 'ledger-1', currentInstanceId: instance.id,
        createdAt: Date.now(), lastActiveAt: Date.now(), archivedAt: null,
      };
      const detail = signal({ chat, conversation: { messages: [] }, currentInstance: instance });
      await configure(ChatDetailComponent, chatDetailTemplate, [FormsModule, DropZoneStubComponent, InputPanelComponent], instance, [
        { provide: Router, useValue: {} },
        { provide: ChatStore, useValue: {
          selectedDetail: detail, sending: signal(false), error: signal(null), setError: vi.fn(), sendMessage: vi.fn(),
          sendMessageTo: vi.fn(), loadOlderMessages: vi.fn(),
        } },
        { provide: InstanceListStore, useValue: { fileToAttachments: vi.fn() } },
        { provide: FileIpcService, useValue: { selectFolder: vi.fn() } },
        { provide: OperatorIpcService, useValue: { onOperatorEvent: vi.fn(() => () => undefined), listRuns: vi.fn(async () => []) } },
        { provide: LoopStopConfirmService, useValue: {} },
        { provide: LoopStore, useValue: { activeForChat: vi.fn(() => null), start: vi.fn() } },
        { provide: LoopPromptHistoryService, useValue: { remember: vi.fn() } },
        { provide: FileAttachmentService, useValue: { prependPendingFolders: (message: string) => message } },
      ]);
      fixture = TestBed.createComponent(ChatDetailComponent);
      fixture.detectChanges();
      const host = fixture.nativeElement as HTMLElement;

      // Guard against a vacuous pass: the composer is mounted for the real chat instance, and the service
      // really would offer compact-first for it.
      expect(host.querySelector('app-input-panel'), 'the chat composer is mounted').toBeTruthy();
      expect(TestBed.inject(ColdCacheResumeService).shouldCompactFirst(instance.id)).toBe(true);

      expect(host.querySelector('app-cold-cache-chip')?.textContent?.trim() ?? '').toBe('');
      expect(host.textContent).not.toContain('expired');
      expect(sendLabel(host)).toBe('Send message');
    });
  });

  describe('instance-detail host (instance-detail template, real composer)', () => {
    it('shows the chip and the "Compact and send" label for the same cold Claude conversation', async () => {
      const instance = coldClaudeInstance('session-1');
      await configure(InstanceDetailComponent, instanceDetailTemplate, [DropZoneStubComponent, InputPanelComponent], instance, [
        { provide: HistoryStore, useValue: { previewConversation: signal(null), restoreEntry: vi.fn(), clearSelection: vi.fn() } },
        { provide: IpcFacadeService, useValue: { forkSession: vi.fn() } },
        { provide: RecentDirectoriesIpcService, useValue: { selectFolderAndTrack: vi.fn() } },
        { provide: ProviderIpcService, useValue: { listModelsForProvider: vi.fn(), onModelsCatalogUpdated: vi.fn(() => () => undefined) } },
        { provide: CrossModelReviewIpcService, useValue: { getReviewForInstance: vi.fn(() => null), dismiss: vi.fn() } },
        { provide: QuickActionDispatcherService, useValue: { dispatch: vi.fn() } },
        { provide: TodoStore, useValue: {
          setSession: vi.fn(), hasTodos: signal(false), currentSessionId: signal(null),
          stats: signal({ total: 0, completed: 0, pending: 0, inProgress: 0 }),
        } },
        { provide: WelcomeCoordinatorService, useValue: {
          pendingFiles: signal([]), pendingFolders: signal([]), workingDirectory: signal<string | null>(null),
          welcomeSelectedNodeId: signal<string | null>(null), remoteBrowseOpen: signal(false),
          remoteBrowseNodeId: signal<string | null>(null), selectedCli: signal('auto'),
          isWelcomeProjectContextLoading: signal(false), projectContext: signal(null),
          resetState: vi.fn(), loadWelcomeProjectContext: vi.fn(),
        } },
        { provide: FileAttachmentService, useValue: { prependPendingFolders: (message: string) => message } },
      ]);
      fixture = TestBed.createComponent(InstanceDetailComponent);
      fixture.detectChanges();
      const host = fixture.nativeElement as HTMLElement;

      expect(host.querySelector('app-input-panel'), 'the live composer is mounted').toBeTruthy();
      const chip = host.querySelector('app-cold-cache-chip');
      expect(chip, 'the chip is mounted').toBeTruthy();
      expect(chip?.textContent).toContain('saved copy of this conversation has expired');
      expect(chip?.textContent).toContain('about 150K tokens');
      expect(sendLabel(host)).toBe('Compact and send');
    });
  });

  describe('composer used on its own', () => {
    it('is off by default and on only when the host sets coldCacheCompactFirst', async () => {
      const instance = coldClaudeInstance('inst-1');
      await configure(InputPanelComponent, inputPanelTemplate, [AioTooltipDirective, ColdCacheChipComponent], instance);
      fixture = TestBed.createComponent(InputPanelComponent);
      const panel = fixture as ComponentFixture<InputPanelComponent>;
      panel.componentRef.setInput('instanceId', 'inst-1');
      panel.componentRef.setInput('workingDirectory', '/repo');
      panel.detectChanges();
      const host = panel.nativeElement as HTMLElement;
      expect(host.querySelector('app-cold-cache-chip')?.textContent?.trim() ?? '').toBe('');
      expect(sendLabel(host)).toBe('Send message');

      panel.componentRef.setInput('coldCacheCompactFirst', true);
      panel.detectChanges();
      expect(host.querySelector('app-cold-cache-chip')?.textContent).toContain('has expired');
      expect(sendLabel(host)).toBe('Compact and send');
    });
  });
});

describe('pending attachment chips', () => {
  let fixture: ComponentFixture<InputPanelComponent>;

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // jsdom has no object-URL support; the composer asks for one per pending file.
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
    TestBed.resetTestingModule();
    TestBed.overrideComponent(InputPanelComponent, {
      set: {
        template: inputPanelTemplate, templateUrl: undefined, styles: [], styleUrl: undefined, styleUrls: [],
        imports: [AppIconButtonDirective, AioTooltipDirective, ColdCacheChipComponent],
      },
    });
    await TestBed.configureTestingModule({
      imports: [InputPanelComponent], providers: composerProviders(coldClaudeInstance('inst-1')),
    }).compileComponents();
  });
  afterEach(() => {
    fixture?.destroy();
    vi.restoreAllMocks();
  });

  const cards = (host: HTMLElement) => Array.from(host.querySelectorAll('.file-preview-card'));

  it('renders two same-named attachments as two separate chips and keeps each chip with its own file', () => {
    // Two different pasted screenshots: the clipboard gives both the same name.
    const first = new File(['first screenshot'], 'image.png', { type: 'image/png' });
    const second = new File(['a second, different screenshot'], 'image.png', { type: 'image/png' });
    fixture = TestBed.createComponent(InputPanelComponent);
    fixture.componentRef.setInput('instanceId', 'inst-1');
    fixture.componentRef.setInput('workingDirectory', '/repo');
    fixture.componentRef.setInput('pendingFiles', [first, second]);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    const [firstCard, secondCard] = cards(host);
    expect(cards(host)).toHaveLength(2);
    expect(firstCard).not.toBe(secondCard);

    // Remove the first file. The second chip must survive as the SAME element: a name-keyed list would
    // keep the first element and delete the second, so the surviving chip would belong to the wrong file.
    fixture.componentRef.setInput('pendingFiles', [second]);
    fixture.detectChanges();
    // `toBe`, not `toEqual`: two chips with the same name look alike structurally, so only identity tells them apart.
    expect(cards(host)).toHaveLength(1);
    expect(cards(host)[0]).toBe(secondCard);
  });
});
