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
import type { HybridSearchOptions, HybridSearchResult } from '../../../../shared/types/codebase.types';
import { ActionDispatchService } from '../../core/services/action-dispatch.service';
import { InstanceStore } from '../../core/state/instance.store';
import { DraftService } from '../../core/services/draft.service';
import { KeybindingService } from '../../core/services/keybinding.service';
import { OrchestrationIpcService } from '../../core/services/ipc';
import { CodebaseIpcService } from '../../core/services/ipc/codebase-ipc.service';
import { PerfInstrumentationService } from '../../core/services/perf-instrumentation.service';
import { PromptSuggestionService } from '../../core/services/prompt-suggestion.service';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { ProviderStateService } from '../../core/services/provider-state.service';
import { CommandStore } from '../../core/state/command.store';
import { PromptHistoryStore } from '../../core/state/prompt-history.store';
import { SettingsStore } from '../../core/state/settings.store';
import { VoiceConversationStore } from '../../core/voice/voice-conversation.store';
import { ComposerAutocompleteComponent } from './composer-autocomplete';
import { InputPanelComponent } from './input-panel.component';
import type { LoopStartConfigInput } from '../../core/services/ipc/loop-ipc.service';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const inputPanelTemplate = readFileSync(
  resolve(specDirectory, './input-panel.component.html'),
  'utf8',
);
const inputPanelStyles = readFileSync(
  resolve(specDirectory, './input-panel.component.scss'),
  'utf8',
);
const composerQueueTemplate = readFileSync(
  resolve(specDirectory, './composer-queue.component.html'),
  'utf8',
);
const composerQueueStyles = readFileSync(
  resolve(specDirectory, './composer-queue.component.scss'),
  'utf8',
);
const loopConfigPanelTemplate = readFileSync(
  resolve(specDirectory, '../loop/loop-config-panel.component.html'),
  'utf8',
);
const loopConfigPanelStyles = readFileSync(
  resolve(specDirectory, '../loop/loop-config-panel.component.scss'),
  'utf8',
);

await resolveComponentResources((url) => {
  if (url.endsWith('input-panel.component.html')) {
    return Promise.resolve(inputPanelTemplate);
  }

  if (url.endsWith('input-panel.component.scss')) {
    return Promise.resolve(inputPanelStyles);
  }

  if (url.endsWith('composer-queue.component.html')) {
    return Promise.resolve(composerQueueTemplate);
  }

  if (url.endsWith('composer-queue.component.scss')) {
    return Promise.resolve(composerQueueStyles);
  }

  if (url.endsWith('loop-config-panel.component.html')) {
    return Promise.resolve(loopConfigPanelTemplate);
  }

  if (url.endsWith('loop-config-panel.component.scss')) {
    return Promise.resolve(loopConfigPanelStyles);
  }

  return Promise.reject(new Error(`Unexpected component resource: ${url}`));
});

@Component({
  selector: 'app-agent-selector',
  standalone: true,
  template: '',
})
class AgentSelectorStubComponent {
  @Input() selectedAgentId = 'build';
  @Output() agentSelected = new EventEmitter<unknown>();
}

@Component({
  selector: 'app-loop-toggle',
  standalone: true,
  template: '',
})
class LoopToggleStubComponent {
  @Input() chatId: string | null = null;
  @Input() workspaceCwd: string | null = null;
  @Input() hasTypedText = false;
  @Input() panelOpen = false;
  @Output() openConfig = new EventEmitter<void>();
  @Output() stopRequested = new EventEmitter<void>();
}

@Component({
  selector: 'app-loop-config-panel',
  standalone: true,
  template: '',
})
class LoopConfigPanelStubComponent {
  @Input() workspaceCwd = '';
  @Input() firstMessageHint = '';
  @Input() seedPrompt: string | null = null;
  @Input() defaultProvider = 'claude';
  @Input() availableProviders: string[] = [];
  @Output() dismissed = new EventEmitter<void>();
  @Output() validityChange = new EventEmitter<boolean>();
  @Output() configChange = new EventEmitter<LoopStartConfigInput | null>();
}

@Component({
  selector: 'app-composer-toolbar',
  standalone: true,
  template: '',
})
class ComposerToolbarStubComponent {
  @Input() instanceId = '';
  @Input() contextUsage: unknown = undefined;
  @Input() provider = 'claude';
  @Input() currentModel: string | undefined = undefined;
  @Input() currentReasoningEffort: unknown = undefined;
  @Input() instanceStatus = 'idle';
}

@Component({
  selector: 'app-composer-queue',
  standalone: true,
  template: '',
})
class ComposerQueueStubComponent {
  @Input() messages: unknown[] = [];
  @Input() holdReasonLabel: string | null = null;
  @Input() canSteer = false;
  @Output() editMessage = new EventEmitter<number>();
  @Output() steerMessage = new EventEmitter<number>();
  @Output() cancelMessage = new EventEmitter<number>();
}

@Component({
  selector: 'app-image-lightbox',
  standalone: true,
  template: '',
})
class ImageLightboxStubComponent {
  @Input() items: unknown[] = [];
}

/**
 * Integration spec for the composer's at-mention / file-path autocomplete
 * (Task 7). Unlike composer-autocomplete.spec.ts (which hosts the overlay in
 * a bare harness), this mounts the REAL InputPanelComponent template with the
 * REAL ComposerAutocompleteComponent so it covers the load-bearing
 * interaction: the overlay's capture-phase key handling must win over the
 * panel's own (keydown) Enter-to-send binding while the menu is open, and
 * must not interfere when it is closed.
 */
describe('InputPanelComponent composer autocomplete integration', () => {
  let fixture: ComponentFixture<InputPanelComponent>;
  let component: InputPanelComponent;
  let codebaseSearch: ReturnType<typeof createCodebaseSearchMock>;

  beforeEach(async () => {
    codebaseSearch = createCodebaseSearchMock();

    TestBed.resetTestingModule();
    TestBed.overrideComponent(InputPanelComponent, {
      set: {
        template: inputPanelTemplate,
        templateUrl: undefined,
        styles: [inputPanelStyles],
        styleUrl: undefined,
        styleUrls: [],
        imports: [
          AgentSelectorStubComponent,
          LoopToggleStubComponent,
          LoopConfigPanelStubComponent,
          ComposerToolbarStubComponent,
          ComposerQueueStubComponent,
          ComposerAutocompleteComponent,
          ImageLightboxStubComponent,
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
        { provide: InstanceStore, useValue: { getInstance: vi.fn(() => undefined) } },
        {
          provide: KeybindingService,
          useValue: { setContext: vi.fn(), onAction: vi.fn(() => vi.fn()) },
        },
        { provide: OrchestrationIpcService, useValue: createOrchestrationIpcMock() },
        { provide: PromptHistoryStore, useValue: createPromptHistoryStoreMock() },
        { provide: VoiceConversationStore, useValue: createVoiceConversationStoreMock() },
        { provide: CodebaseIpcService, useValue: { search: codebaseSearch } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(InputPanelComponent);
    component = fixture.componentInstance;
    (component as unknown as { instanceId: () => string }).instanceId = () => 'inst-1';
    (component as unknown as { workingDirectory: () => string | null }).workingDirectory = () => '/repo';
    fixture.detectChanges();
  });

  it('opens file suggestions backed by codebase search when typing an @ query', async () => {
    await typeInComposer('see @src');

    expect(codebaseSearch).toHaveBeenCalledWith(expect.objectContaining({
      query: 'src',
      storeId: 'default',
      workspacePath: '/repo',
    }));

    const items = overlayItems();
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('src/main/input-panel.component.ts'),
      expect.stringContaining('src/renderer/app/shared/utils/focus-trap.ts'),
    ]);
  });

  it('accepts the selected completion with Enter instead of sending, preserving textarea focus', async () => {
    const sent: string[] = [];
    component.sendMessage.subscribe((text) => sent.push(text));

    await typeInComposer('see @src');
    const textarea = getTextarea();

    expect(textarea.dispatchEvent(keydown('ArrowDown'))).toBe(false);
    fixture.detectChanges();
    expect(textarea.dispatchEvent(keydown('Enter'))).toBe(false);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(sent).toEqual([]);
    expect(textarea.value).toBe('see @src/renderer/app/shared/utils/focus-trap.ts ');
    expect(textarea.selectionStart).toBe(textarea.value.length);
    expect(component.message()).toBe(textarea.value);
    expect(document.activeElement).toBe(textarea);
    expect(overlay()).toBeNull();
  });

  it('keeps Enter-to-send behavior unchanged when no completion menu is open', async () => {
    const sent: string[] = [];
    component.sendMessage.subscribe((text) => sent.push(text));

    await typeInComposer('hello');
    expect(overlay()).toBeNull();

    getTextarea().dispatchEvent(keydown('Enter'));
    await fixture.whenStable();
    await Promise.resolve();

    expect(sent).toEqual(['hello']);
    expect(component.message()).toBe('');
  });

  it('dismisses the overlay with Escape while preserving the composer draft', async () => {
    await typeInComposer('see @src');
    expect(overlay()).not.toBeNull();

    expect(getTextarea().dispatchEvent(keydown('Escape'))).toBe(false);
    fixture.detectChanges();

    expect(overlay()).toBeNull();
    expect(getTextarea().value).toBe('see @src');
    expect(component.message()).toBe('see @src');
  });

  function getTextarea(): HTMLTextAreaElement {
    return fixture.nativeElement.querySelector('textarea.message-input') as HTMLTextAreaElement;
  }

  function overlay(): Element | null {
    return fixture.nativeElement.querySelector('.composer-completions');
  }

  function overlayItems(): HTMLButtonElement[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.composer-completion-item'),
    );
  }

  async function typeInComposer(value: string): Promise<void> {
    const textarea = getTextarea();
    textarea.focus();
    textarea.value = value;
    textarea.setSelectionRange(value.length, value.length);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 130));
    await fixture.whenStable();
    await Promise.resolve();
    fixture.detectChanges();
  }
});

function keydown(key: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
}

function createCodebaseSearchMock() {
  return vi.fn<(
    options: HybridSearchOptions,
  ) => Promise<{ success: true; data: HybridSearchResult[] }>>().mockResolvedValue({
    success: true,
    data: [
      searchResult('/repo/src/main/input-panel.component.ts', 20),
      searchResult('/repo/src/renderer/app/shared/utils/focus-trap.ts', 10),
    ],
  });
}

function searchResult(filePath: string, score: number): HybridSearchResult {
  return {
    sectionId: `${filePath}:1:1`,
    filePath,
    content: '',
    startLine: 1,
    endLine: 1,
    score,
    matchType: 'bm25',
    language: 'typescript',
  };
}

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
    selectedModel: signal<string>(''),
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
    workflowNlSuggest: vi.fn(async () => ({ success: false })),
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
