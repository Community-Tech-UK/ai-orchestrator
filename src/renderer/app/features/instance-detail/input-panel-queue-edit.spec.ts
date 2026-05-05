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
import type { ProviderType } from '../providers/provider-selector.component';
import { ActionDispatchService } from '../../core/services/action-dispatch.service';
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

const specDirectory = dirname(fileURLToPath(import.meta.url));
const inputPanelTemplate = readFileSync(
  resolve(specDirectory, './input-panel.component.html'),
  'utf8',
);
const inputPanelStyles = readFileSync(
  resolve(specDirectory, './input-panel.component.scss'),
  'utf8',
);

await resolveComponentResources((url) => {
  if (url.endsWith('input-panel.component.html')) {
    return Promise.resolve(inputPanelTemplate);
  }

  if (url.endsWith('input-panel.component.scss')) {
    return Promise.resolve(inputPanelStyles);
  }

  return Promise.reject(new Error(`Unexpected component resource: ${url}`));
});

@Component({
  selector: 'app-provider-selector',
  standalone: true,
  template: '',
})
class ProviderSelectorStubComponent {
  @Input() provider: ProviderType = 'claude';
  @Output() providerSelected = new EventEmitter<ProviderType>();
}

@Component({
  selector: 'app-copilot-model-selector',
  standalone: true,
  template: '',
})
class CopilotModelSelectorStubComponent {
  @Input() model = '';
  @Output() modelSelected = new EventEmitter<string>();
}

@Component({
  selector: 'app-agent-selector',
  standalone: true,
  template: '',
})
class AgentSelectorStubComponent {
  @Input() selectedAgentId = 'build';
  @Output() agentSelected = new EventEmitter<unknown>();
}

describe('InputPanelComponent queued message editing', () => {
  let fixture: ComponentFixture<InputPanelComponent>;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    TestBed.overrideComponent(InputPanelComponent, {
      set: {
        template: inputPanelTemplate,
        templateUrl: undefined,
        styles: [inputPanelStyles],
        styleUrl: undefined,
        styleUrls: [],
        imports: [
          ProviderSelectorStubComponent,
          CopilotModelSelectorStubComponent,
          AgentSelectorStubComponent,
        ],
      },
    });

    await TestBed.configureTestingModule({
      imports: [InputPanelComponent],
      providers: [
        { provide: CommandStore, useValue: createCommandStoreMock() },
        { provide: DraftService, useValue: createDraftServiceMock() },
        { provide: PromptSuggestionService, useValue: { getSuggestion: vi.fn(() => null) } },
        { provide: PerfInstrumentationService, useValue: { markComposerLatency: vi.fn(() => vi.fn()) } },
        { provide: ProviderStateService, useValue: createProviderStateMock() },
        { provide: NewSessionDraftService, useValue: createNewSessionDraftMock() },
        { provide: SettingsStore, useValue: { defaultYoloMode: signal(false) } },
        { provide: ActionDispatchService, useValue: { dispatch: vi.fn() } },
        { provide: KeybindingService, useValue: { setContext: vi.fn() } },
        { provide: OrchestrationIpcService, useValue: createOrchestrationIpcMock() },
        { provide: PromptHistoryStore, useValue: createPromptHistoryStoreMock() },
        { provide: VoiceConversationStore, useValue: createVoiceConversationStoreMock() },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(InputPanelComponent);
    (fixture.componentInstance as unknown as {
      instanceId: () => string;
      instanceStatus: () => string;
      queuedMessages: () => { message: string }[];
    }).instanceId = () => 'inst-1';
    (fixture.componentInstance as unknown as {
      instanceId: () => string;
      instanceStatus: () => string;
      queuedMessages: () => { message: string }[];
    }).instanceStatus = () => 'busy';
    (fixture.componentInstance as unknown as {
      instanceId: () => string;
      instanceStatus: () => string;
      queuedMessages: () => { message: string }[];
    }).queuedMessages = () => [
      { message: 'first queued message' },
      { message: 'second queued message' },
    ];
    fixture.detectChanges();
  });

  it('emits the queued message index when the edit button is clicked', () => {
    const emitted: number[] = [];
    (fixture.componentInstance as unknown as {
      editQueuedMessage: { subscribe(callback: (index: number) => void): void };
    }).editQueuedMessage.subscribe((index) => emitted.push(index));

    const editButtons = fixture.nativeElement.querySelectorAll('.queued-edit-btn');
    expect(editButtons).toHaveLength(2);

    (editButtons[1] as HTMLButtonElement).click();

    expect(emitted).toEqual([1]);
  });

  it('emits a draft workflow launch instead of showing a start-session error', async () => {
    const component = fixture.componentInstance;
    (component as unknown as { instanceId: () => string }).instanceId = () => 'new';
    component.message.set('plans/2026-05-03-browser-gateway-first-milestone.md\n\nPlease review this plan');
    component.nlWorkflowSuggestion.set({
      size: 'medium',
      surface: 'template-confirm',
      suggestedRef: 'pr-review',
      matchedSignals: ['workflow-keyword-review'],
      estimatedProviderImpact: 'low',
    });

    const emitted: { message: string; templateId: string }[] = [];
    (component as unknown as {
      startSessionWithWorkflow: {
        subscribe(callback: (event: { message: string; templateId: string }) => void): void;
      };
    }).startSessionWithWorkflow.subscribe((event) => emitted.push(event));
    const orchestration = TestBed.inject(OrchestrationIpcService) as unknown as {
      workflowCanTransition: ReturnType<typeof vi.fn>;
      workflowStart: ReturnType<typeof vi.fn>;
    };

    await component.acceptNlWorkflowSuggestion();

    expect(emitted).toEqual([
      {
        message: 'plans/2026-05-03-browser-gateway-first-milestone.md\n\nPlease review this plan',
        templateId: 'pr-review',
      },
    ]);
    expect(component.nlWorkflowSuggestionError()).toBeNull();
    expect(orchestration.workflowCanTransition).not.toHaveBeenCalled();
    expect(orchestration.workflowStart).not.toHaveBeenCalled();
  });

  it('sends text that starts with an absolute path as a normal message', async () => {
    const component = fixture.componentInstance;
    const commandStore = TestBed.inject(CommandStore) as unknown as {
      resolveCommand: ReturnType<typeof vi.fn>;
      executeCommand: ReturnType<typeof vi.fn>;
    };
    const sent: string[] = [];
    (component as unknown as {
      sendMessage: { subscribe(callback: (text: string) => void): void };
    }).sendMessage.subscribe((text) => sent.push(text));

    commandStore.resolveCommand.mockResolvedValue({
      kind: 'none',
      query: 'Users/suas/work/Dingley/auth.md',
    });
    component.message.set('/Users/suas/work/Dingley/auth.md\n\nplease review this');

    await component.onSend();
    fixture.detectChanges();

    const error = fixture.nativeElement.querySelector('.composer-inline-error');
    expect(sent).toEqual(['/Users/suas/work/Dingley/auth.md\n\nplease review this']);
    expect(commandStore.resolveCommand).not.toHaveBeenCalled();
    expect(commandStore.executeCommand).not.toHaveBeenCalled();
    expect(component.message()).toBe('');
    expect(error).toBeNull();
  });

  it('shows an error when sending text that starts with an unknown slash command', async () => {
    const component = fixture.componentInstance;
    const commandStore = TestBed.inject(CommandStore) as unknown as {
      resolveCommand: ReturnType<typeof vi.fn>;
      executeCommand: ReturnType<typeof vi.fn>;
    };
    const sent: string[] = [];
    (component as unknown as {
      sendMessage: { subscribe(callback: (text: string) => void): void };
    }).sendMessage.subscribe((text) => sent.push(text));

    commandStore.resolveCommand.mockResolvedValue({
      kind: 'none',
      query: 'not-a-command',
    });
    component.message.set('/not-a-command please review this');

    await component.onSend();
    fixture.detectChanges();

    const error = fixture.nativeElement.querySelector('.composer-inline-error');
    expect(sent).toEqual([]);
    expect(commandStore.executeCommand).not.toHaveBeenCalled();
    expect(component.message()).toBe('/not-a-command please review this');
    if (!error) {
      throw new Error('Expected slash command error to render');
    }
    expect(error.textContent).toContain('No slash command found for /not-a-command');
  });
});

function createCommandStoreMock(): Partial<CommandStore> {
  return {
    loadCommands: vi.fn(),
    commands: signal([]),
    commandEligibility: vi.fn(() => ({ eligible: true })),
    getCommandByName: vi.fn(() => undefined),
    resolveCommand: vi.fn(),
    executeCommand: vi.fn(),
  };
}

function createDraftServiceMock(): Partial<DraftService> {
  const textVersion = signal(0);
  return {
    textVersion,
    getDraft: vi.fn(() => ''),
    setDraft: vi.fn(),
    clearDraft: vi.fn(),
  };
}

function createProviderStateMock(): Partial<ProviderStateService> {
  return {
    selectedProvider: signal<ProviderType>('claude'),
    selectedModel: signal<string | undefined>(undefined),
    setProvider: vi.fn(),
    setModel: vi.fn(),
  };
}

function createNewSessionDraftMock(): Partial<NewSessionDraftService> {
  return {
    revision: signal(0),
    prompt: signal(''),
    provider: signal<ProviderType | null>(null),
    model: signal<string | null>(null),
    yoloMode: signal<boolean | null>(null),
    agentId: signal('build'),
    setProvider: vi.fn(),
    setModel: vi.fn(),
    setAgentId: vi.fn(),
    setYoloMode: vi.fn(),
    setPrompt: vi.fn(),
    clearActiveComposer: vi.fn(),
  };
}

function createOrchestrationIpcMock(): Partial<OrchestrationIpcService> {
  return {
    workflowNlSuggest: vi.fn(),
    workflowCanTransition: vi.fn(),
    workflowStart: vi.fn(),
  };
}

function createPromptHistoryStoreMock(): Partial<PromptHistoryStore> {
  return {
    requestedRecallEntry: signal(null),
    getEntriesForRecall: vi.fn(() => []),
    clearRequestedRecallEntry: vi.fn(),
    record: vi.fn(),
  };
}

function createVoiceConversationStoreMock(): Partial<VoiceConversationStore> {
  return {
    mode: signal('off') as VoiceConversationStore['mode'],
    partialTranscript: signal('') as VoiceConversationStore['partialTranscript'],
    error: signal(null) as VoiceConversationStore['error'],
    errorCode: signal(null) as VoiceConversationStore['errorCode'],
    transcriptDetached: signal(false) as VoiceConversationStore['transcriptDetached'],
    audioLevel: signal(0) as VoiceConversationStore['audioLevel'],
    updateContext: vi.fn(),
    stop: vi.fn(),
    detachTranscript: vi.fn(),
    start: vi.fn(),
    setTemporaryOpenAiKey: vi.fn(),
  };
}
