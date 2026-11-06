/**
 * The card and the message box only meet through the shared registry, so this
 * mounts both in one app and types into the box, the way a person would.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Component,
  EventEmitter,
  Input,
  Output,
  signal,
  ɵresolveComponentResources as resolveComponentResources,
  NO_ERRORS_SCHEMA,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { By } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { ChatDetailComponent } from '../chats/chat-detail.component';
import { ChatStore } from '../../core/state/chat.store';
import { InstanceListStore } from '../../core/state/instance/instance-list.store';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { OperatorIpcService } from '../../core/services/ipc/operator-ipc.service';
import { FileAttachmentService } from './file-attachment.service';
import { LoopStore } from '../../core/state/loop.store';
import { LoopStopConfirmService } from '../loop/loop-stop-confirm.service';
import { LoopPromptHistoryService } from '../loop/loop-prompt-history.service';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderType } from '../../core/services/provider-state.service';
import { ActionDispatchService } from '../../core/services/action-dispatch.service';
import { InstanceStore } from '../../core/state/instance.store';
import { InstanceMessagingStore } from '../../core/state/instance/instance-messaging.store';
import { DraftService } from '../../core/services/draft.service';
import { KeybindingService } from '../../core/services/keybinding.service';
import { InstanceIpcService, IpcEventBusService, IpcFacadeService, OrchestrationIpcService } from '../../core/services/ipc';
import { PerfInstrumentationService } from '../../core/services/perf-instrumentation.service';
import { PromptSuggestionService } from '../../core/services/prompt-suggestion.service';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { ProviderStateService } from '../../core/services/provider-state.service';
import { CommandStore } from '../../core/state/command.store';
import { PromptHistoryStore } from '../../core/state/prompt-history.store';
import { SettingsStore } from '../../core/state/settings.store';
import { VoiceConversationStore } from '../../core/voice/voice-conversation.store';
import { InputPanelComponent } from './input-panel.component';
import { UserActionRequestComponent } from './user-action-request.component';

const directory = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(resolve(directory, name), 'utf8');
const panelTemplate = read('./input-panel.component.html');
const panelStyles = read('./input-panel.component.scss');
const cardTemplate = read('./user-action-request.component.html');
const cardStyles = read('./user-action-request.component.scss');

await resolveComponentResources((url) => {
  if (url.endsWith('input-panel.component.html')) return Promise.resolve(panelTemplate);
  if (url.endsWith('input-panel.component.scss')) return Promise.resolve(panelStyles);
  if (url.endsWith('user-action-request.component.html')) return Promise.resolve(cardTemplate);
  if (url.endsWith('user-action-request.component.scss')) return Promise.resolve(cardStyles);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected component resource: ${url}`));
});

@Component({ selector: 'app-agent-selector', standalone: true, template: '' })
class AgentSelectorStub {
  @Input() selectedAgentId = 'build';
  @Output() agentSelected = new EventEmitter<unknown>();
}
@Component({ selector: 'app-loop-toggle', standalone: true, template: '' })
class LoopToggleStub {
  @Input() chatId: string | null = null;
  @Input() workspaceCwd: string | null = null;
  @Input() hasTypedText = false;
  @Input() panelOpen = false;
  @Output() openConfig = new EventEmitter<void>();
  @Output() stopRequested = new EventEmitter<void>();
}
@Component({ selector: 'app-loop-config-panel', standalone: true, template: '' })
class LoopConfigPanelStub {
  @Input() workspaceCwd = '';
  @Input() firstMessageHint = '';
  @Input() seedPrompt: string | null = null;
  @Input() defaultProvider = 'claude';
  @Input() availableProviders: string[] = [];
  @Output() dismissed = new EventEmitter<void>();
  @Output() validityChange = new EventEmitter<boolean>();
  @Output() configChange = new EventEmitter<unknown>();
}
@Component({ selector: 'app-composer-toolbar', standalone: true, template: '' })
class ComposerToolbarStub {
  @Input() instanceId = '';
  @Input() contextUsage: unknown = undefined;
  @Input() provider = 'claude';
  @Input() currentModel: string | undefined = undefined;
  @Input() currentReasoningEffort: unknown = undefined;
  @Input() desiredRuntime: unknown = undefined;
  @Input() instanceStatus = 'idle';
  @Input() accountProfileId: string | undefined = undefined;
  @Input() accountRoutingSource: string | undefined = undefined;
}
@Component({ selector: 'app-composer-queue', standalone: true, template: '' })
class ComposerQueueStub {
  @Input() messages: { message: string }[] = [];
  @Input() holdReasonLabel: string | null = null;
  @Input() canSteer = false;
  @Output() editMessage = new EventEmitter<number>();
  @Output() steerMessage = new EventEmitter<number>();
  @Output() cancelMessage = new EventEmitter<number>();
}
@Component({ selector: 'app-composer-autocomplete', standalone: true, template: '' })
class ComposerAutocompleteStub {
  @Input() textarea: HTMLTextAreaElement | null = null;
  @Input() workspaceCwd: string | null = null;
}
@Component({ selector: 'app-interrupted-continuation', standalone: true, template: '' })
class InterruptedContinuationStub { @Input() instanceId = ''; }
@Component({ selector: 'app-image-lightbox', standalone: true, template: '' })
class ImageLightboxStub {
  @Input() items: unknown[] = [];
}

describe('chat detail typed composer and its question card', () => {
  let host: ComponentFixture<ChatDetailComponent>;
  let card: ComponentFixture<UserActionRequestComponent>;
  let panel: ComponentFixture<InputPanelComponent>;
  let receive: (payload: { instanceId: string; requestId: string; prompt: string; timestamp: number; metadata?: Record<string, unknown> }) => void;

  const ipc = {
    listUserActionRequestsForInstance: vi.fn(),
    onUserActionRequest: vi.fn(() => vi.fn()),
    onInputRequired: vi.fn(),
    onInputRequiredResolved: vi.fn(() => vi.fn()),
    onInstanceRemoved: () => () => undefined,
    onInstanceStateUpdate: () => () => undefined,
    onBatchUpdate: () => () => undefined,
    respondToUserAction: vi.fn(),
    respondToInputRequired: vi.fn(),
    submitSecretCard: vi.fn(),
    declineSecretCard: vi.fn(),
    toggleYoloMode: vi.fn(),
  };
  const instanceStore = {
    getInstance: vi.fn(),
    clearPendingApprovals: vi.fn(),
    decrementPendingApproval: vi.fn(),
    changeAgentMode: vi.fn(),
    setLocalYoloMode: vi.fn(),
    isQueueParked: () => false,
    instanceActivities: signal(new Map()),
  };
  const draftService = { attachmentVersion: signal(0), getPendingFiles: vi.fn((): File[] => []), getPendingFolders: vi.fn((): string[] => []), textVersion: signal(0), getDraft: vi.fn(() => ''), clearPendingFiles: vi.fn(), clearPendingFolders: vi.fn(), setDraft: vi.fn(), clearDraft: vi.fn() };
  const commandStore = {
    loadCommands: vi.fn(),
    commands: signal([]),
    commandEligibility: vi.fn(() => ({ eligible: true })),
    getCommandByName: vi.fn(),
    resolveCommand: vi.fn(),
    executeCommand: vi.fn(),
  };

  async function settle(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await host.whenStable();
      await Promise.resolve();
      host.detectChanges();
    }
  }

  async function ask(requestId: string, metadata: Record<string, unknown>, prompt = 'A question') {
    receive({ instanceId: 'inst-1', requestId, prompt, timestamp: 1_900_000_000_000, metadata });
    await settle();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    draftService.getPendingFiles.mockReturnValue([]);
    draftService.getPendingFolders.mockReturnValue([]);
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:question-preview'), revokeObjectURL: vi.fn() });
    ipc.listUserActionRequestsForInstance.mockResolvedValue({ success: true, data: [] });
    // The event bus listens (and the card reads from it), so a delivery reaches every listener.
    const listeners = new Set<typeof receive>();
    receive = (payload) => listeners.forEach((listener) => listener(payload));
    ipc.onInputRequired.mockImplementation((callback: typeof receive) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    });
    ipc.respondToInputRequired.mockResolvedValue({ success: true, data: {} });
    instanceStore.getInstance.mockReturnValue({ id: 'inst-1', outputBuffer: [], status: 'busy', yoloMode: false });

    TestBed.resetTestingModule();
    TestBed.overrideComponent(ChatDetailComponent, { set: {
      template: read('../chats/chat-detail.component.html'), templateUrl: undefined, styles: [], styleUrl: undefined,
      imports: [FormsModule, InputPanelComponent, UserActionRequestComponent], schemas: [NO_ERRORS_SCHEMA],
    } });
    TestBed.overrideComponent(InputPanelComponent, {
      set: {
        template: panelTemplate,
        templateUrl: undefined,
        styles: [panelStyles],
        styleUrl: undefined,
        styleUrls: [],
        imports: [AgentSelectorStub, LoopToggleStub, LoopConfigPanelStub, ComposerToolbarStub, ComposerQueueStub, ComposerAutocompleteStub, ImageLightboxStub, InterruptedContinuationStub],
      },
    });
    await TestBed.configureTestingModule({
      imports: [ChatDetailComponent],
      providers: [
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: ChatStore, useValue: {
          selectedDetail: signal({ chat: { id: 'chat-1', ledgerThreadId: 'thread-1', name: 'Chat', provider: 'claude', currentCwd: '/work', currentInstanceId: 'inst-1' }, conversation: { messages: [] }, currentInstance: null }),
          error: signal(null), sending: signal(false), sendMessage: vi.fn(), sendMessageTo: vi.fn(), setError: vi.fn(),
        } },
        { provide: InstanceListStore, useValue: { fileToAttachments: vi.fn() } },
        { provide: FileIpcService, useValue: {} },
        { provide: OperatorIpcService, useValue: { onOperatorEvent: () => vi.fn(), listRuns: vi.fn().mockResolvedValue({ success: true, data: [] }) } },
        { provide: FileAttachmentService, useValue: { prependPendingFolders: (text: string) => text } },
        { provide: LoopStore, useValue: { runningChatIds: signal(new Set()), activeForChat: () => signal(null) } },
        { provide: LoopStopConfirmService, useValue: {} },
        { provide: LoopPromptHistoryService, useValue: {} },
        { provide: IpcFacadeService, useValue: ipc },
        { provide: InstanceIpcService, useValue: ipc },
        { provide: InstanceStore, useValue: instanceStore },
        { provide: InstanceMessagingStore, useValue: { getQueuedMessageCount: vi.fn(() => 0) } },
        { provide: CommandStore, useValue: commandStore },
        { provide: DraftService, useValue: draftService },
        { provide: PromptSuggestionService, useValue: { getSuggestion: vi.fn(() => null) } },
        { provide: PerfInstrumentationService, useValue: { markComposerLatency: vi.fn(() => vi.fn()) } },
        { provide: ProviderStateService, useValue: { selectedProvider: signal<ProviderType>('claude'), selectedModel: signal(''), setProvider: vi.fn(), setModel: vi.fn() } },
        {
          provide: NewSessionDraftService,
          useValue: {
            revision: signal(0), activeKey: signal('__default__'), prompt: signal(''), provider: signal(null), model: signal(null),
            yoloMode: signal(null), agentId: signal('build'), setProvider: vi.fn(), setModel: vi.fn(), setAgentId: vi.fn(),
            setYoloMode: vi.fn(), setPrompt: vi.fn(), clearActiveComposer: vi.fn(),
          },
        },
        { provide: SettingsStore, useValue: { defaultYoloMode: signal(false), showThinking: signal(false), thinkingDefaultExpanded: signal(false), showToolMessages: signal(false) } },
        { provide: ActionDispatchService, useValue: { dispatch: vi.fn() } },
        { provide: KeybindingService, useValue: { setContext: vi.fn(), onAction: vi.fn(() => vi.fn()) } },
        { provide: OrchestrationIpcService, useValue: { workflowNlSuggest: vi.fn(), workflowCanTransition: vi.fn(), workflowStart: vi.fn() } },
        { provide: PromptHistoryStore, useValue: { requestedRecallEntry: signal(null), getEntriesForRecall: vi.fn(() => []), clearRequestedRecallEntry: vi.fn(), record: vi.fn() } },
        {
          provide: VoiceConversationStore,
          useValue: {
            mode: signal('off'), partialTranscript: signal(''), error: signal(null), errorCode: signal(null),
            transcriptDetached: signal(false), audioLevel: signal(0), updateContext: vi.fn(), stop: vi.fn(),
            detachTranscript: vi.fn(), start: vi.fn(), setTemporaryOpenAiKey: vi.fn(),
          },
        },
      ],
    }).compileComponents();

    // InstanceStore subscribes at startup, before a card mounts.
    TestBed.inject(IpcEventBusService).inputRequired$.subscribe();
    host = TestBed.createComponent(ChatDetailComponent);
    host.detectChanges();
    const cardDebug = host.debugElement.query(By.directive(UserActionRequestComponent));
    const panelDebug = host.debugElement.query(By.directive(InputPanelComponent));
    card = { componentInstance: cardDebug.componentInstance, nativeElement: cardDebug.nativeElement } as ComponentFixture<UserActionRequestComponent>;
    panel = { componentInstance: panelDebug.componentInstance, nativeElement: panelDebug.nativeElement } as ComponentFixture<InputPanelComponent>;
    await settle();
  });

  it('answers a card on the chat runtime and preserves the chat attachments', async () => {
    const file = new File(['notes'], 'notes.txt');
    draftService.getPendingFiles.mockReturnValue([file]);
    draftService.attachmentVersion.update(value => value + 1);
    await ask('chat-q', { type: 'ask_user_question', questions: [{ question: 'Which?', options: [{ label: 'Bun' }] }] });
    panel.componentInstance.message.set('Bun');
    await panel.componentInstance.onSend();
    await settle();
    expect(ipc.respondToInputRequired.mock.calls.at(-1)?.slice(0, 4)).toEqual(['inst-1', 'chat-q', 'Which?: Bun', undefined]);
    expect(TestBed.inject(ChatStore).sendMessage).not.toHaveBeenCalled();
    expect(panel.componentInstance.pendingFiles()).toEqual([file]);
  });

  it('keeps a permission card out of typed answer routing', async () => {
    await ask('chat-perm', { type: 'deferred_permission', tool_name: 'Read' }, 'Allow Read?');
    panel.componentInstance.message.set('yes');
    await panel.componentInstance.onSend();
    await host.whenStable();
    expect(ipc.respondToInputRequired).not.toHaveBeenCalled();
    expect(TestBed.inject(ChatStore).sendMessage).toHaveBeenCalledWith('yes', undefined);
    expect((card.nativeElement as HTMLElement).textContent).toContain('Allow Read?');
  });
});
