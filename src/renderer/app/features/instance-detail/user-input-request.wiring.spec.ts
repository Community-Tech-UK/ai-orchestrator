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
} from '@angular/core';
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
@Component({ selector: 'app-image-lightbox', standalone: true, template: '' })
class ImageLightboxStub {
  @Input() items: unknown[] = [];
}

describe('typing into the message box while a card is waiting (card and box together)', () => {
  let card: ComponentFixture<UserActionRequestComponent>;
  let panel: ComponentFixture<InputPanelComponent>;
  let sent: string[];
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
  };
  const draftService = { textVersion: signal(0), getDraft: vi.fn(() => ''), setDraft: vi.fn(), clearDraft: vi.fn() };
  const commandStore = {
    loadCommands: vi.fn(),
    commands: signal([]),
    commandEligibility: vi.fn(() => ({ eligible: true })),
    getCommandByName: vi.fn(),
    resolveCommand: vi.fn(),
    executeCommand: vi.fn(),
  };
  const helpCommand = { id: 'help', name: 'help', description: '', template: '', builtIn: true, createdAt: 1, updatedAt: 1 };

  async function settle(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await card.whenStable();
      await Promise.resolve();
      card.detectChanges();
      panel.detectChanges();
    }
  }

  async function ask(requestId: string, metadata: Record<string, unknown>, prompt = 'A question') {
    receive({ instanceId: 'inst-1', requestId, prompt, timestamp: 1_900_000_000_000, metadata });
    await settle();
  }

  const receipts = () =>
    Array.from((card.nativeElement as HTMLElement).querySelectorAll('.receipt-text')).map((node) => node.textContent);

  beforeEach(async () => {
    vi.clearAllMocks();
    sent = [];
    ipc.listUserActionRequestsForInstance.mockResolvedValue({ success: true, data: [] });
    // The event bus listens (and the card reads from it), so a delivery reaches every listener.
    const listeners = new Set<typeof receive>();
    receive = (payload) => listeners.forEach((listener) => listener(payload));
    ipc.onInputRequired.mockImplementation((callback: typeof receive) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    });
    ipc.respondToInputRequired.mockResolvedValue({ success: true, data: {} });
    instanceStore.getInstance.mockReturnValue({ status: 'busy', yoloMode: false });

    TestBed.resetTestingModule();
    TestBed.overrideComponent(InputPanelComponent, {
      set: {
        template: panelTemplate,
        templateUrl: undefined,
        styles: [panelStyles],
        styleUrl: undefined,
        styleUrls: [],
        imports: [AgentSelectorStub, LoopToggleStub, LoopConfigPanelStub, ComposerToolbarStub, ComposerQueueStub, ComposerAutocompleteStub, ImageLightboxStub],
      },
    });
    await TestBed.configureTestingModule({
      imports: [InputPanelComponent, UserActionRequestComponent],
      providers: [
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
        { provide: SettingsStore, useValue: { defaultYoloMode: signal(false) } },
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
    card = TestBed.createComponent(UserActionRequestComponent);
    (card.componentInstance as unknown as { instanceId: () => string }).instanceId = signal('inst-1');
    panel = TestBed.createComponent(InputPanelComponent);
    (panel.componentInstance as unknown as { instanceId: () => string }).instanceId = () => 'inst-1';
    (panel.componentInstance as unknown as { sendMessage: { subscribe(callback: (text: string) => void): void } })
      .sendMessage.subscribe((text) => sent.push(text));
    card.detectChanges();
    panel.detectChanges();
    await settle();
  });

  it('answers a question with the label that was typed, and leaves a receipt', async () => {
    await ask('req-1', {
      type: 'ask_user_question',
      questions: [{ header: 'Flow', question: 'Which posting flow?', multiSelect: false, options: [{ label: 'Approve each' }, { label: 'Autonomous' }] }],
    });
    expect((card.nativeElement as HTMLElement).textContent).toContain('Which posting flow?');

    panel.componentInstance.message.set('autonomous');
    await panel.componentInstance.onSend();
    await settle();

    expect(ipc.respondToInputRequired.mock.calls.at(-1)?.slice(0, 4)).toEqual(['inst-1', 'req-1', 'Flow: Autonomous', undefined]);
    expect(sent).toEqual([]);
    expect(panel.componentInstance.message()).toBe('');
    expect((card.nativeElement as HTMLElement).textContent).not.toContain('Which posting flow?');
    expect(receipts()).toEqual(['You answered: Autonomous']);
  });

  it('never lets typed text approve a tool: it goes out as an ordinary message and the card stays', async () => {
    await ask('perm-1', { type: 'deferred_permission', tool_name: 'Bash', tool_use_id: 't1' }, 'Allow Bash?');

    panel.componentInstance.message.set('yes, allow it');
    await panel.componentInstance.onSend();
    await settle();

    expect(sent).toEqual(['yes, allow it']);
    expect(ipc.respondToInputRequired).not.toHaveBeenCalled();
    expect((card.nativeElement as HTMLElement).textContent).toContain('Allow Bash?');
  });

  it('keeps what was typed, and the card, when the answer cannot be delivered', async () => {
    ipc.respondToInputRequired.mockResolvedValueOnce({ success: false, error: { message: 'Session is restarting' } });
    await ask('mcp-1', { type: 'mcp_elicitation', serverName: 'docs' }, '[docs] Pick a page');

    panel.componentInstance.message.set('Getting started');
    await panel.componentInstance.onSend();
    await settle();

    expect(sent).toEqual([]);
    expect(panel.componentInstance.message()).toBe('Getting started');
    expect((card.nativeElement as HTMLElement).textContent).toContain('Pick a page');
    expect((card.nativeElement as HTMLElement).textContent).toContain('Session is restarting');
  });

  describe('answers that start with a slash', () => {
    const slashChoices = [{
      header: 'Next',
      question: 'What next?',
      multiSelect: false,
      options: [{ label: '/help' }, { label: '/quit' }],
    }];

    it('picks a choice whose label is exactly a slash command, instead of running the command', async () => {
      commandStore.getCommandByName.mockImplementation((name: string) => (name === 'help' ? helpCommand : undefined));
      await ask('req-1', { type: 'ask_user_question', questions: slashChoices });

      panel.componentInstance.message.set('/help');
      await panel.componentInstance.onSend();
      await settle();

      expect(commandStore.executeCommand).not.toHaveBeenCalled();
      expect(ipc.respondToInputRequired.mock.calls.at(-1)?.slice(0, 4)).toEqual(['inst-1', 'req-1', 'Next: /help', undefined]);
      expect(sent).toEqual([]);
      expect(receipts()).toEqual(['You answered: /help']);
    });

    it('sends other slash-led text as the typed answer, even when a command has that name', async () => {
      commandStore.getCommandByName.mockImplementation((name: string) => (name === 'help' ? helpCommand : undefined));
      await ask('req-1', { type: 'ask_user_question', questions: slashChoices });

      panel.componentInstance.message.set('/help me decide');
      await panel.componentInstance.onSend();
      await settle();

      expect(commandStore.executeCommand).not.toHaveBeenCalled();
      expect(ipc.respondToInputRequired.mock.calls.at(-1)?.slice(0, 4)).toEqual(['inst-1', 'req-1', 'Next: /help me decide', undefined]);
    });

    it('Enter answers the question even while slash suggestions are open', async () => {
      commandStore.commands.set([helpCommand] as never[]);
      await ask('req-enter', { type: 'ask_user_question', questions: slashChoices });
      const textarea = panel.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
      textarea.value = '/help';
      textarea.dispatchEvent(new Event('input'));
      panel.detectChanges();
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
      expect(commandStore.executeCommand).not.toHaveBeenCalled();
      expect(ipc.respondToInputRequired.mock.calls.at(-1)?.slice(0, 4)).toEqual(['inst-1', 'req-enter', 'Next: /help', undefined]);
      commandStore.commands.set([]);
    });

    it('hides old fuzzy command choices while an agent question owns the text', async () => {
      await ask('req-slash-menu', { type: 'ask_user_question', questions: slashChoices });
      panel.componentInstance.slashResolution.set({ kind: 'fuzzy', query: 'hel', suggestions: [helpCommand] });
      panel.componentInstance.showCommandSuggestions.set(true);
      panel.detectChanges();
      expect(panel.componentInstance.visibleCommandSuggestions()).toEqual([]);
      panel.componentInstance.message.set('/help');
      await panel.componentInstance.onSend();
      expect(commandStore.executeCommand).not.toHaveBeenCalled();
      expect(ipc.respondToInputRequired.mock.calls.at(-1)?.slice(0, 3)).toEqual(['inst-1', 'req-slash-menu', 'Next: /help']);
    });

    it('runs the command normally once nothing is waiting', async () => {
      commandStore.getCommandByName.mockImplementation((name: string) => (name === 'help' ? helpCommand : undefined));

      panel.componentInstance.message.set('/help');
      await panel.componentInstance.onSend();

      expect(commandStore.executeCommand).toHaveBeenCalledWith('help', 'inst-1', []);
      expect(ipc.respondToInputRequired).not.toHaveBeenCalled();
    });

    it('still never lets slash text approve a tool', async () => {
      commandStore.getCommandByName.mockImplementation((name: string) => (name === 'help' ? helpCommand : undefined));
      await ask('perm-1', { type: 'deferred_permission', tool_name: 'Bash', tool_use_id: 't1' }, 'Allow Bash?');

      panel.componentInstance.message.set('/help');
      await panel.componentInstance.onSend();
      await settle();

      expect(ipc.respondToInputRequired).not.toHaveBeenCalled();
      expect(commandStore.executeCommand).toHaveBeenCalledWith('help', 'inst-1', []);
      expect((card.nativeElement as HTMLElement).textContent).toContain('Allow Bash?');
    });
  });

  it('goes back to ordinary sending once the question has closed', async () => {
    await ask('mcp-1', { type: 'mcp_elicitation', serverName: 'docs' }, '[docs] Pick a page');
    panel.componentInstance.message.set('Getting started');
    await panel.componentInstance.onSend();
    await settle();

    panel.componentInstance.message.set('Now run the tests');
    await panel.componentInstance.onSend();

    expect(sent).toEqual(['Now run the tests']);
  });
});
