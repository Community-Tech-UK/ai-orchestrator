/**
 * Component-level cover for the wiring the 28 July data-loss incident broke.
 *
 * `InputPanelComponent.onSend()` used to call `sendMessage.emit(text)` and then
 * `clearSubmittedMessage()` synchronously — Angular output emit is synchronous,
 * so the composer text, the persisted draft and the staged `File[]` were all
 * wiped the moment the async handler suspended at its first `await`, long
 * before the main process had accepted anything.
 *
 * The pure helpers are covered in `input-panel-new-session-submit.spec.ts`.
 * This spec exercises the component itself: that a draft send routes to
 * `newSessionSubmit` (not `sendMessage`), and that nothing is cleared until the
 * handler acknowledges with an instance id.
 */

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputPanelComponent } from './input-panel.component';
import type { NewSessionSubmitRequest } from './input-panel-new-session-submit';
import { ComposerSubmissionService } from '../../core/services/composer-submission.service';
import { MemoryComposerSubmissionStorage } from '../../core/services/composer-submission-store';
import { CommandStore } from '../../core/state/command.store';
import { DraftService } from '../../core/services/draft.service';
import { PromptSuggestionService } from '../../core/services/prompt-suggestion.service';
import { PerfInstrumentationService } from '../../core/services/perf-instrumentation.service';
import { ProviderStateService } from '../../core/services/provider-state.service';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { SettingsStore } from '../../core/state/settings.store';
import { ActionDispatchService } from '../../core/services/action-dispatch.service';
import { KeybindingService } from '../../core/services/keybinding.service';
import { OrchestrationIpcService } from '../../core/services/ipc';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { InstanceStore } from '../../core/state/instance.store';
import { PromptHistoryStore } from '../../core/state/prompt-history.store';
import { VoiceConversationStore } from '../../core/voice/voice-conversation.store';
import { LoopPanelOpenerService } from '../loop/loop-panel-opener.service';

function screenshot(index: number): File {
  const bytes = new Uint8Array(4096);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return new File([bytes], `pasted-image-${index}.png`, { type: 'image/png' });
}

const LONG_PROMPT = 'None of the Community Tech automations are working.\n'.repeat(200).trim();

// The component declares templateUrl/styleUrl, which this JIT test environment
// cannot fetch. Satisfy the resolver with empty resources; the real template is
// exercised by `input-panel.component.spec.ts` and this spec overrides it with
// a stub, because what is under test here is the class wiring.
await resolveComponentResources(() => Promise.resolve(''));

describe('InputPanelComponent new-session submission wiring', () => {
  let fixture: ComponentFixture<InputPanelComponent>;
  let component: InputPanelComponent;
  let submissions: ComposerSubmissionService;
  let storage: MemoryComposerSubmissionStorage;
  let clearActiveComposer: ReturnType<typeof vi.fn>;
  let setPrompt: ReturnType<typeof vi.fn>;
  let sendMessageEmissions: string[];
  let submitRequests: NewSessionSubmitRequest[];

  /** Drain the microtask queue so the awaited journal write settles. */
  async function flush(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  }

  beforeEach(async () => {
    // jsdom has no object-URL support; the composer builds preview URLs for
    // every staged image.
    vi.stubGlobal('URL', Object.assign(globalThis.URL, {
      createObjectURL: vi.fn(() => 'blob:preview'),
      revokeObjectURL: vi.fn(),
    }));
    storage = new MemoryComposerSubmissionStorage();
    sendMessageEmissions = [];
    submitRequests = [];

    // The composer mirrors its text into the draft store and re-reads it via a
    // sync effect, so the mock has to actually hold the value — a bare vi.fn()
    // would let the effect blank the textarea on the next change detection.
    const prompt = signal('');
    setPrompt = vi.fn((value: string) => prompt.set(value));
    clearActiveComposer = vi.fn(() => prompt.set(''));

    const newSessionDraft = {
      revision: signal(0),
      activeKey: signal('project:/Users/suas/work/communitytech'),
      prompt,
      provider: signal(null),
      model: signal(null),
      modelRuntimeTarget: signal(null),
      reasoningEffort: signal(null),
      nodeId: signal(null),
      yoloMode: signal(null),
      hardened: signal(null),
      launchMode: signal(null),
      agentId: signal('build'),
      setProvider: vi.fn(),
      setModel: vi.fn(),
      setAgentId: vi.fn(),
      setYoloMode: vi.fn(),
      setHardened: vi.fn(),
      setModelRuntimeTarget: vi.fn(),
      setReasoningEffort: vi.fn(),
      setNodeId: vi.fn(),
      setLaunchMode: vi.fn(),
      setPrompt,
      clearActiveComposer,
    };

    TestBed.resetTestingModule();
    // The component declares templateUrl/styleUrl, which the JIT compiler in
    // this test environment cannot resolve. The template is exercised by
    // `input-panel.component.spec.ts`; this spec covers the class wiring, so a
    // stub template is enough.
    TestBed.overrideComponent(InputPanelComponent, {
      set: {
        template: '<div></div>',
        templateUrl: undefined,
        styles: [],
        styleUrl: undefined,
        styleUrls: [],
        imports: [],
      },
    });
    await TestBed.configureTestingModule({
      imports: [InputPanelComponent],
      providers: [
        { provide: CommandStore, useValue: { commands: signal([]), loadCommands: vi.fn(), commandEligibility: vi.fn(() => ({ eligible: true })), getCommandByName: vi.fn(() => undefined), resolveCommand: vi.fn(async () => null), executeCommand: vi.fn() } },
        { provide: DraftService, useValue: { textVersion: signal(0), getDraft: vi.fn(() => ''), setDraft: vi.fn(), clearDraft: vi.fn() } },
        { provide: PromptSuggestionService, useValue: { getSuggestion: vi.fn(() => null) } },
        { provide: PerfInstrumentationService, useValue: { markComposerLatency: vi.fn(() => vi.fn()) } },
        { provide: ProviderStateService, useValue: { selectedProvider: signal('claude'), selectedModel: signal('opus'), getFastModeForProvider: vi.fn(() => false), getLaunchModeForProvider: vi.fn(() => 'orchestrated'), rememberFastModeForProvider: vi.fn(), rememberModelForProvider: vi.fn() } },
        { provide: NewSessionDraftService, useValue: newSessionDraft },
        { provide: SettingsStore, useValue: { defaultYoloMode: signal(false) } },
        { provide: ActionDispatchService, useValue: { dispatch: vi.fn() } },
        { provide: KeybindingService, useValue: { setContext: vi.fn(), onAction: vi.fn(() => vi.fn()) } },
        { provide: OrchestrationIpcService, useValue: { workflowNlSuggest: vi.fn(async () => ({ success: false })), workflowCanTransition: vi.fn(), workflowStart: vi.fn() } },
        { provide: InstanceIpcService, useValue: {} },
        { provide: ElectronIpcService, useValue: { platform: 'darwin' } },
        { provide: InstanceStore, useValue: { getInstance: vi.fn(() => undefined) } },
        { provide: PromptHistoryStore, useValue: { requestedRecallEntry: signal(null), getEntriesForRecall: vi.fn(() => []), clearRequestedRecallEntry: vi.fn(), record: vi.fn() } },
        { provide: VoiceConversationStore, useValue: { mode: signal('off'), error: signal(null), errorCode: signal(null), partialTranscript: signal(''), providerSummary: signal(''), audioLevel: signal(0), stop: vi.fn(), start: vi.fn(), updateContext: vi.fn(), detachTranscript: vi.fn() } },
        { provide: LoopPanelOpenerService, useValue: { pending: signal(null), consume: vi.fn(() => null) } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(InputPanelComponent);
    component = fixture.componentInstance;
    submissions = TestBed.inject(ComposerSubmissionService);
    submissions._setStorageForTesting(storage);

    fixture.componentRef.setInput('instanceId', 'new');
    fixture.componentRef.setInput('workingDirectory', '/Users/suas/work/communitytech');
    fixture.componentRef.setInput('pendingFiles', [0, 1, 2, 3, 4, 5].map(screenshot));

    component.sendMessage.subscribe((text) => sendMessageEmissions.push(text));
    component.newSessionSubmit.subscribe((request) => submitRequests.push(request));

    setPrompt(LONG_PROMPT);
    component.message.set(LONG_PROMPT);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.unstubAllGlobals();
  });

  it('routes a draft send to newSessionSubmit and clears nothing before acknowledgement', async () => {
    const sending = component.onSend();
    await flush();

    // The fire-and-forget `sendMessage` path is what allowed the loss.
    expect(sendMessageEmissions).toEqual([]);
    expect(submitRequests).toHaveLength(1);
    expect(submitRequests[0].text).toBe(LONG_PROMPT);
    expect(submitRequests[0].files).toHaveLength(6);

    // Nothing cleared while the acknowledgement is outstanding.
    expect(component.message()).toBe(LONG_PROMPT);
    expect(clearActiveComposer).not.toHaveBeenCalled();
    expect(component.submission.submitting()).toBe(true);
    expect(await storage.list()).toHaveLength(1);

    submitRequests[0].onResolved({ ok: true, instanceId: 'inst-42' });
    await sending;

    expect(component.message()).toBe('');
    expect(clearActiveComposer).toHaveBeenCalledTimes(1);
    expect(component.submission.submitting()).toBe(false);
  });

  it('keeps the composition and surfaces the reason when the handler reports a failure', async () => {
    const sending = component.onSend();
    await flush();

    submitRequests[0].onResolved({ ok: false, error: 'IPC validation failed' });
    await sending;
    await Promise.resolve();

    expect(component.message()).toBe(LONG_PROMPT);
    expect(clearActiveComposer).not.toHaveBeenCalled();
    expect(component.submission.error()).toBe('IPC validation failed');

    const recoverable = component.submission.recoverable();
    expect(recoverable?.files).toHaveLength(6);
    expect(recoverable?.text).toBe(LONG_PROMPT);
  });

  it('refuses a second send while one is outstanding', async () => {
    const sending = component.onSend();
    await flush();

    expect(component.canSend()).toBe(false);
    await component.onSend();
    expect(submitRequests).toHaveLength(1);

    submitRequests[0].onResolved({ ok: true, instanceId: 'inst-1' });
    await sending;
  });
});
