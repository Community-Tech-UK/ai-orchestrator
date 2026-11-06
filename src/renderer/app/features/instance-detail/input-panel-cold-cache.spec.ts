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
import { ColdCacheChipComponent } from './cold-cache-chip.component';
import { COLD_CACHE_IDLE_MS } from './cold-cache-resume';
import { ColdCacheResumeService } from './cold-cache-resume.service';
import { InputPanelComponent } from './input-panel.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
// The REAL composer template: the chip mount and the send-button label are what is under test.
const inputPanelTemplate = readFileSync(resolve(specDirectory, './input-panel.component.html'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('input-panel.component.html')) return Promise.resolve(inputPanelTemplate);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected component resource: ${url}`));
});

describe('InputPanelComponent cold-cache wiring', () => {
  let fixture: ComponentFixture<InputPanelComponent>;
  let instance: { id: string; provider: string; status: string; contextUsage: unknown; outputBuffer: unknown[] };
  const compactInstance = vi.fn();

  beforeEach(async () => {
    // Child components other than the chip are intentionally not declared; Angular logs each as unknown.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    compactInstance.mockReset().mockResolvedValue(true);
    instance = {
      id: 'inst-1', provider: 'claude', status: 'idle',
      contextUsage: { used: 150_000, total: 200_000, percentage: 75, occupancyReported: true },
      outputBuffer: [{ id: 'a1', type: 'assistant', content: 'earlier', timestamp: Date.now() - COLD_CACHE_IDLE_MS - 60_000 }],
    };

    TestBed.resetTestingModule();
    TestBed.overrideComponent(InputPanelComponent, {
      set: {
        template: inputPanelTemplate, templateUrl: undefined, styles: [], styleUrl: undefined, styleUrls: [],
        imports: [AppIconButtonDirective, AioTooltipDirective, ColdCacheChipComponent],
      },
    });
    await TestBed.configureTestingModule({
      imports: [InputPanelComponent],
      providers: [
        ColdCacheResumeService,
        { provide: InstanceStore, useValue: {
          getInstance: () => instance, isInstanceCompacting: () => false, isQueueParked: () => false, compactInstance,
        } },
        { provide: InstanceMessagingStore, useValue: { getQueuedMessageCount: () => 0 } },
        { provide: SettingsStore, useValue: {
          defaultYoloMode: signal(false),
          settings: signal({ providerSignalFenceEnabled: true, coldCacheCompactFirst: true }),
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
        { provide: ElectronIpcService, useValue: { platform: 'darwin' } },
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
      ],
    }).compileComponents();
  });

  afterEach(() => {
    fixture?.destroy();
    vi.restoreAllMocks();
  });

  function render(instanceId: string): HTMLElement {
    fixture = TestBed.createComponent(InputPanelComponent);
    fixture.componentRef.setInput('instanceId', instanceId);
    fixture.componentRef.setInput('workingDirectory', '/repo');
    // The instance-detail host opts in; the composer itself defaults to off (see input-panel-cold-cache-hosts.spec.ts).
    fixture.componentRef.setInput('coldCacheCompactFirst', true);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }
  const sendLabel = (host: HTMLElement) => host.querySelector('button.btn-send')?.getAttribute('aria-label');

  it('mounts the cold-cache chip and relabels Send when the service offers compact-first', () => {
    const host = render('inst-1');
    const chip = host.querySelector('app-cold-cache-chip');
    expect(chip, 'chip is mounted in the composer').toBeTruthy();
    expect(chip?.textContent).toContain('saved copy of this conversation has expired');
    expect(chip?.textContent).toContain('about 150K tokens');
    expect(sendLabel(host)).toBe('Compact and send');
  });

  it('goes back to the plain Send label once "Send with full history" is chosen, but keeps the chip', () => {
    const host = render('inst-1');
    TestBed.inject(ColdCacheResumeService).setPreferCompact('inst-1', false);
    fixture.detectChanges();
    expect(host.querySelector('app-cold-cache-chip')?.textContent).toContain('Send with full history');
    expect(sendLabel(host)).toBe('Send message');
  });

  it('shows no chip and the plain label when the conversation is not cold', () => {
    instance.outputBuffer = [{ id: 'a1', type: 'assistant', content: 'recent', timestamp: Date.now() }];
    const host = render('inst-1');
    expect(host.querySelector('app-cold-cache-chip')?.textContent?.trim()).toBe('');
    expect(sendLabel(host)).toBe('Send message');
  });

  it('never mounts the chip or the compact label on the new-session composer', () => {
    const host = render('new');
    expect(host.querySelector('app-cold-cache-chip')).toBeNull();
    expect(sendLabel(host)).not.toBe('Compact and send');
  });
});
