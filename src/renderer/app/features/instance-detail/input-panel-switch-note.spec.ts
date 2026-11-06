import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionDispatchService } from '../../core/services/action-dispatch.service';
import { AppIpcService } from '../../core/services/ipc/app-ipc.service';
import { CodebaseIpcService } from '../../core/services/ipc/codebase-ipc.service';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { OrchestrationIpcService } from '../../core/services/ipc';
import { DraftService } from '../../core/services/draft.service';
import { KeybindingService } from '../../core/services/keybinding.service';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { PerfInstrumentationService } from '../../core/services/perf-instrumentation.service';
import { PromptSuggestionService } from '../../core/services/prompt-suggestion.service';
import { ProviderStateService } from '../../core/services/provider-state.service';
import { CommandStore } from '../../core/state/command.store';
import { InstanceStore } from '../../core/state/instance.store';
import { InstanceMessagingStore } from '../../core/state/instance/instance-messaging.store';
import { PromptHistoryStore } from '../../core/state/prompt-history.store';
import { SettingsStore } from '../../core/state/settings.store';
import { VoiceConversationStore } from '../../core/voice/voice-conversation.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { AppIconButtonDirective } from '../../shared/tooltip/icon-button.directive';
import { ComposerToolbarComponent } from './composer-toolbar.component';
import { UnifiedCatalogStore } from '../models/unified-catalog.store';
import { DynamicModelCatalogService } from '../models/dynamic-model-catalog.service';
import { getModelsForProvider } from '../../../../shared/types/provider.types';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { ToastService } from '../../core/services/toast.service';
import { ProviderAccountIpcService } from '../../core/services/ipc/provider-account-ipc.service';
import type { OutputMessage } from '../../core/state/instance/instance.types';
import { InputPanelComponent } from './input-panel.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
// The REAL composer template: the chip mount and the send-button label are what is under test.
const inputPanelTemplate = readFileSync(resolve(specDirectory, './input-panel.component.html'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('input-panel.component.html')) return Promise.resolve(inputPanelTemplate);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected component resource: ${url}`));
});

/**
 * Plan 12a/14d, composer side: InputPanel decides whether the session has a
 * conversation (`[hasConversation]="hasConversation()"`, input-panel.component.html)
 * and hands it, with `residentClaude` and `remoteExecution`, to the toolbar,
 * whose picker shows the pre-click switch note. This renders the REAL composer
 * template with the real toolbar, picker and panel. A buffer holding only
 * system lines is not a conversation (no note); a user or assistant message is.
 */
describe('InputPanelComponent model switch note wiring', () => {
  let fixture: ComponentFixture<InputPanelComponent>;

  const system: OutputMessage = { id: 's1', type: 'system', content: 'Session started', timestamp: 1 };
  const user: OutputMessage = { id: 'u1', type: 'user', content: 'read a file', timestamp: 2 };
  const assistant: OutputMessage = { id: 'a1', type: 'assistant', content: 'done', timestamp: 3 };
  const instance = { id: 'inst-1', provider: 'claude', status: 'idle', contextUsage: undefined, outputBuffer: [] as OutputMessage[] };
  const compactInstance = vi.fn();

  beforeEach(async () => {
    // Children other than the toolbar are intentionally not declared; Angular logs each as unknown.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    TestBed.resetTestingModule();
    TestBed.overrideComponent(InputPanelComponent, {
      set: {
        template: inputPanelTemplate, templateUrl: undefined, styles: [], styleUrl: undefined, styleUrls: [],
        imports: [AppIconButtonDirective, AioTooltipDirective, ComposerToolbarComponent],
      },
    });
    await TestBed.configureTestingModule({
      imports: [InputPanelComponent],
      providers: [
        { provide: InstanceStore, useValue: {
          getInstance: () => instance, isInstanceCompacting: () => false, isQueueParked: () => false, compactInstance,
        } },
        { provide: InstanceMessagingStore, useValue: { getQueuedMessageCount: () => 0 } },
        { provide: SettingsStore, useValue: {
          defaultYoloMode: signal(false),
          settings: signal({ providerSignalFenceEnabled: true, coldCacheCompactFirst: true }),
          isInitialized: () => true,
        } },
        { provide: CommandStore, useValue: {
          loadCommands: vi.fn(), commands: signal([]), commandEligibility: vi.fn(() => ({ eligible: true })),
          getCommandByName: vi.fn(() => undefined), resolveCommand: vi.fn(), executeCommand: vi.fn(),
        } },
        { provide: DraftService, useValue: {
          textVersion: signal(0), getDraft: vi.fn(() => ''), setDraft: vi.fn(), clearDraft: vi.fn(),
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
        // The catalogue talks to the main process; the picker only needs the static rows here.
        { provide: UnifiedCatalogStore, useValue: {
          ensureLoaded: vi.fn(), displayModelsForProvider: vi.fn(() => []), lastBuiltAt: signal<number | null>(null),
        } },
        { provide: DynamicModelCatalogService, useValue: {
          ensureLoaded: vi.fn(), modelsFor: vi.fn((provider: string) => getModelsForProvider(provider)),
        } },
        { provide: InstanceIpcService, useValue: { changeModel: vi.fn() } },
        { provide: ToastService, useValue: { show: vi.fn() } },
        { provide: ProviderAccountIpcService, useValue: { list: vi.fn().mockResolvedValue({ profiles: [], pools: {} }) } },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    fixture?.destroy();
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => { el.innerHTML = ''; });
    vi.restoreAllMocks();
  });

  /** Renders the live composer with the given buffer and returns the note the open picker shows. */
  function noteWith(
    messages: OutputMessage[],
    extra: { residentClaude?: boolean; remoteExecution?: boolean } = {},
  ): string | null {
    fixture = TestBed.createComponent(InputPanelComponent);
    fixture.componentRef.setInput('instanceId', 'inst-1');
    fixture.componentRef.setInput('workingDirectory', '/repo');
    fixture.componentRef.setInput('provider', 'claude');
    fixture.componentRef.setInput('currentModel', 'sonnet');
    fixture.componentRef.setInput('instanceStatus', 'idle');
    fixture.componentRef.setInput('outputMessages', messages);
    fixture.componentRef.setInput('residentClaude', extra.residentClaude ?? true);
    fixture.componentRef.setInput('remoteExecution', extra.remoteExecution ?? false);
    fixture.detectChanges();
    const chip = (fixture.nativeElement as HTMLElement).querySelector('.compact-picker__chip') as HTMLButtonElement | null;
    expect(chip, 'the toolbar picker is mounted in the live composer').not.toBeNull();
    chip!.click();
    fixture.detectChanges();
    expect(document.querySelector('app-model-selection-panel'), 'the menu opened').not.toBeNull();
    return document.querySelector('.model-picker-note[role="note"]')?.textContent?.trim() ?? null;
  }

  it('shows no note while the buffer holds only system lines', () => {
    expect(noteWith([system])).toBeNull();
  });

  it('shows no note for an empty buffer', () => {
    expect(noteWith([])).toBeNull();
  });

  it.each([
    ['a user message', [system, user]],
    ['an assistant message', [system, assistant]],
  ])('shows the in-place note once the buffer holds %s', (_label, messages) => {
    expect(noteWith(messages as OutputMessage[])).toContain('Switches in place.');
  });

  it('forwards residentClaude: a non-resident session gets the restart sentence', () => {
    expect(noteWith([user, assistant], { residentClaude: false })).toContain('Switching starts a fresh Claude session.');
  });

  it('forwards remoteExecution: remote Claude keeps the restart sentence', () => {
    expect(noteWith([user, assistant], { residentClaude: true, remoteExecution: true }))
      .toContain('Switching starts a fresh Claude session.');
  });
});
