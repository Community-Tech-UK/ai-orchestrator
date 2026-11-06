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
import { OrchestrationIpcService } from '../../core/services/ipc';
import { PerfInstrumentationService } from '../../core/services/perf-instrumentation.service';
import { PromptSuggestionService } from '../../core/services/prompt-suggestion.service';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { ProviderStateService } from '../../core/services/provider-state.service';
import { CommandStore } from '../../core/state/command.store';
import { PromptHistoryStore } from '../../core/state/prompt-history.store';
import { SettingsStore } from '../../core/state/settings.store';
import { VoiceConversationStore } from '../../core/voice/voice-conversation.store';
import { InputPanelComponent } from './input-panel.component';
import {
  UserInputRequestRegistry,
  type QuestionCardHandle,
  type QuestionOfferResult,
} from './user-input-request.registry';

const directory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(directory, './input-panel.component.html'), 'utf8');
const styles = readFileSync(resolve(directory, './input-panel.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('input-panel.component.html')) return Promise.resolve(template);
  if (url.endsWith('input-panel.component.scss')) return Promise.resolve(styles);
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

describe('InputPanelComponent answering a waiting question', () => {
  let fixture: ComponentFixture<InputPanelComponent>;
  let component: InputPanelComponent;
  let sent: string[];
  let steered: string[];
  let removedFiles: File[];
  const draftService = { textVersion: signal(0), getDraft: vi.fn(() => ''), setDraft: vi.fn(), clearDraft: vi.fn() };
  const commandStore = {
    loadCommands: vi.fn(),
    commands: signal([]),
    commandEligibility: vi.fn(() => ({ eligible: true })),
    getCommandByName: vi.fn(),
    resolveCommand: vi.fn(),
    executeCommand: vi.fn(),
  };

  function question(requestId: string, result: QuestionOfferResult | Promise<QuestionOfferResult>, instanceId = 'inst-1') {
    const handle: QuestionCardHandle & { answer: ReturnType<typeof vi.fn> } = {
      requestId,
      instanceId,
      createdAt: 1,
      answer: vi.fn(async () => result),
    };
    TestBed.inject(UserInputRequestRegistry).replace(`test ${requestId}`, [handle]);
    return handle;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    sent = [];
    steered = [];
    removedFiles = [];
    commandStore.getCommandByName.mockReturnValue(undefined);
    TestBed.resetTestingModule();
    TestBed.overrideComponent(InputPanelComponent, {
      set: {
        template,
        templateUrl: undefined,
        styles: [styles],
        styleUrl: undefined,
        styleUrls: [],
        imports: [AgentSelectorStub, LoopToggleStub, LoopConfigPanelStub, ComposerToolbarStub, ComposerQueueStub, ComposerAutocompleteStub, ImageLightboxStub],
      },
    });
    await TestBed.configureTestingModule({
      imports: [InputPanelComponent],
      providers: [
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
        { provide: InstanceStore, useValue: { getInstance: vi.fn(() => undefined), isQueueParked: () => false } },
        { provide: InstanceMessagingStore, useValue: { getQueuedMessageCount: vi.fn(() => 0) } },
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

    fixture = TestBed.createComponent(InputPanelComponent);
    component = fixture.componentInstance;
    (component as unknown as { instanceId: () => string }).instanceId = () => 'inst-1';
    (component as unknown as { sendMessage: { subscribe(callback: (text: string) => void): void } }).sendMessage.subscribe((text) => sent.push(text));
    (component as unknown as { steerMessage: { subscribe(callback: (text: string) => void): void } }).steerMessage.subscribe((text) => steered.push(text));
    (component as unknown as { removeFile: { subscribe(callback: (file: File) => void): void } }).removeFile.subscribe((file) => removedFiles.push(file));
    fixture.detectChanges();
  });

  it('sends the typed text to the waiting question instead of as a new message', async () => {
    const card = question('q1', 'answered');
    component.message.set('Bun');

    await component.onSend();

    expect(card.answer).toHaveBeenCalledWith('Bun');
    expect(sent).toEqual([]);
    expect(component.message()).toBe('');
    expect(draftService.clearDraft).toHaveBeenCalledWith('inst-1');
  });

  it('clears the box when a multi-question card took the text but wants more', async () => {
    question('q1', 'partial');
    component.message.set('first answer');

    await component.onSend();

    expect(sent).toEqual([]);
    expect(component.message()).toBe('');
  });

  it('keeps the typed text when the answer could not be delivered', async () => {
    question('q1', 'failed');
    component.message.set('Bun');

    await component.onSend();

    expect(sent).toEqual([]);
    expect(component.message()).toBe('Bun');
    expect(draftService.clearDraft).not.toHaveBeenCalledWith('inst-1');
  });

  it('keeps the typed text and sends nothing while an earlier answer is still on its way', async () => {
    question('q1', 'busy');
    component.message.set('Bun');

    await component.onSend();

    expect(sent).toEqual([]);
    expect(component.message()).toBe('Bun');
  });

  it('sends the text as an ordinary message when the question has already gone', async () => {
    question('q1', 'not-applicable');
    component.message.set('Bun');

    await component.onSend();

    expect(sent).toEqual(['Bun']);
    expect(component.message()).toBe('');
  });

  it('sends ordinary messages as before when no question is waiting', async () => {
    component.message.set('Please continue');

    await component.onSend();

    expect(sent).toEqual(['Please continue']);
  });

  const compactCommand = { id: 'compact', name: 'compact', description: '', template: '', builtIn: true, createdAt: 1, updatedAt: 1 };

  it('gives text that starts with a slash to the waiting question, not to the command list', async () => {
    const card = question('q1', 'answered');
    commandStore.getCommandByName.mockReturnValue(compactCommand);
    component.message.set('/compact');

    await component.onSend();

    expect(card.answer).toHaveBeenCalledWith('/compact');
    expect(commandStore.executeCommand).not.toHaveBeenCalled();
    expect(commandStore.getCommandByName).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(component.message()).toBe('');
  });

  it('keeps a slash-led answer in the box when it could not be delivered, and still does not run it', async () => {
    const card = question('q1', 'failed');
    commandStore.getCommandByName.mockReturnValue(compactCommand);
    component.message.set('/compact');

    await component.onSend();

    expect(card.answer).toHaveBeenCalledWith('/compact');
    expect(commandStore.executeCommand).not.toHaveBeenCalled();
    expect(component.message()).toBe('/compact');
  });

  it('runs a slash command as usual when no question is waiting', async () => {
    commandStore.getCommandByName.mockReturnValue(compactCommand);
    component.message.set('/compact');

    await component.onSend();

    expect(commandStore.executeCommand).toHaveBeenCalledWith('compact', 'inst-1', []);
    expect(sent).toEqual([]);
  });

  it('runs the command if the question had already closed by the time the text arrived', async () => {
    const card = question('q1', 'not-applicable');
    commandStore.getCommandByName.mockReturnValue(compactCommand);
    component.message.set('/compact');

    await component.onSend();

    expect(card.answer).toHaveBeenCalledWith('/compact');
    expect(commandStore.executeCommand).toHaveBeenCalledWith('compact', 'inst-1', []);
  });

  it('leaves attached files where they are when the text answers a question', async () => {
    const file = new File(['x'], 'design.png', { type: 'image/png' });
    (component as unknown as { pendingFiles: () => File[] }).pendingFiles = () => [file];
    question('q1', 'answered');
    component.message.set('this one');

    await component.onSend();

    expect(component.pendingFiles()).toEqual([file]);
    expect(removedFiles).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('does not wipe what was typed while the answer was being delivered', async () => {
    let finish: (result: QuestionOfferResult) => void = () => undefined;
    question('q1', new Promise<QuestionOfferResult>((resolve) => { finish = resolve; }));
    component.message.set('Bun');

    const sending = component.onSend();
    component.message.set('and one more thought');
    finish('answered');
    await sending;

    expect(component.message()).toBe('and one more thought');
  });

  it('offers an answer before an armed loop can consume the typed text', async () => {
    const card = question('q1', 'answered');
    component.loopArmed.set(true);
    component.message.set('Bun');
    await component.onSend();
    expect(card.answer).toHaveBeenCalledWith('Bun');
    expect(component.loopStarting()).toBe(false);
    expect(sent).toEqual([]);
  });

  it('leaves Steer alone: it still interrupts the turn rather than answering', async () => {
    const card = question('q1', 'answered');
    component.message.set('stop and do this instead');

    await component.onSteer();

    expect(steered).toEqual(['stop and do this instead']);
    expect(card.answer).not.toHaveBeenCalled();
  });

  it('only answers questions for the session it is typing into', async () => {
    const other = question('q1', 'answered', 'inst-2');
    component.message.set('Bun');

    await component.onSend();

    expect(other.answer).not.toHaveBeenCalled();
    expect(sent).toEqual(['Bun']);
  });
});
