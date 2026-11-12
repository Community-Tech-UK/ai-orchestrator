import { By } from '@angular/platform-browser';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { AppIconButtonDirective } from '../../shared/tooltip/icon-button.directive';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Component,
  EventEmitter,
  Input,
  Output,
  input,
  output,
  signal,
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderType } from '../../core/services/provider-state.service';
import type { HybridSearchOptions, HybridSearchResult } from '../../../../shared/types/codebase.types';
import { ActionDispatchService } from '../../core/services/action-dispatch.service';
import { AppIpcService } from '../../core/services/ipc/app-ipc.service';
import { InstanceStore } from '../../core/state/instance.store';
import { DraftService } from '../../core/services/draft.service';
import { ComposerFocusService } from '../../core/services/composer-focus.service';
import { KeybindingService } from '../../core/services/keybinding.service';
import { OrchestrationIpcService } from '../../core/services/ipc';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { CodebaseIpcService } from '../../core/services/ipc/codebase-ipc.service';
import { PerfInstrumentationService } from '../../core/services/perf-instrumentation.service';
import { PromptSuggestionService } from '../../core/services/prompt-suggestion.service';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { ProviderStateService } from '../../core/services/provider-state.service';
import type { ModelRuntimeTarget } from '../../../../shared/types/local-model-runtime.types';
import { CommandStore } from '../../core/state/command.store';
import { PromptHistoryStore } from '../../core/state/prompt-history.store';
import { SettingsStore } from '../../core/state/settings.store';
import { VoiceConversationStore } from '../../core/voice/voice-conversation.store';
import { ComposerAutocompleteComponent } from './composer-autocomplete';
import { InputPanelComponent } from './input-panel.component';
import { ColdCacheResumeService } from './cold-cache-resume.service';
import { ComposerRecoveryBannerComponent } from './composer-recovery-banner.component';
import { RunReadinessBannerComponent } from './run-readiness-banner.component';
import { InlineHintComponent } from '../../shared/hint/inline-hint.component';
import type { InstanceStatus, OutputMessage } from '../../core/state/instance/instance.types';
import type { ContextUsage, InstanceWaitReason } from '../../../../shared/types/instance.types';
import { ComposerQuotaNoticeComponent } from './composer-quota-notice.component';
import { ProviderQuotaStore } from '../../core/state/provider-quota.store';
import type { ProviderQuotaSnapshot } from '../../../../shared/types/provider-quota.types';
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

  // `resolveComponentResources` is global: it resolves pending resources for
  // EVERY component left in the shared registry by other specs in this worker,
  // not just the ones under test here. Rejecting an unrelated resource fails
  // this whole suite for a component it never renders — which is what happened
  // when the loop feature gained new components. Resolve the rest to empty.
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
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
  selector: 'app-compact-model-picker',
  template: '',
})
class CompactModelPickerStubComponent {
  mode = input('pending-create');
  providers = input<string[]>([]);
  selection = input<unknown>();
  selectedLocalModelNodeId = input<string | null>(null);
  selectionChange = output<unknown>();
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
  @Input() hasConversation = false;
  @Input() residentClaude = false;
  @Input() remoteExecution = false;
  @Input() provider = 'claude';
  @Input() currentModel: string | undefined = undefined;
  @Input() currentReasoningEffort: unknown = undefined;
  @Input() runtimeSummary: unknown = undefined;
  @Input() desiredRuntime: unknown = undefined;
  @Input() instanceStatus = 'idle';
  @Input() accountProfileId: string | undefined = undefined;
  @Input() accountRoutingSource: string | undefined = undefined;
  @Output() quickAskRequested = new EventEmitter<void>();
}

@Component({ selector: 'app-quick-ask-panel', standalone: true, template: '<div class="quick-ask-test">Quick ask open</div>' })
class QuickAskPanelStubComponent {
  @Input() instanceId = '';
  @Input() contextUsage: ContextUsage | null = null;
  @Output() closed = new EventEmitter<void>();
}

@Component({ selector: 'app-cold-cache-chip', standalone: true, template: '' })
class ColdCacheChipStubComponent { @Input() instanceId = ''; }

@Component({
  selector: 'app-composer-queue',
  standalone: true,
  template: '',
})
class ComposerQueueStubComponent {
  @Input() messages: unknown[] = [];
  @Input() holdReasonLabel: string | null = null;
  @Input() canSteer = false;
  @Input() parked = false;
  @Output() editMessage = new EventEmitter<number>();
  @Output() steerMessage = new EventEmitter<number>();
  @Output() cancelMessage = new EventEmitter<number>();
  @Output() resumeQueue = new EventEmitter<void>();
}

@Component({ selector: 'app-composer-banners', standalone: true, template: '' })
class ComposerBannersStubComponent {
  @Input() instanceId = '';
  @Input() waitReason: InstanceWaitReason | undefined;
  @Input() instanceStatus: InstanceStatus = 'idle';
}

@Component({ selector: 'app-copilot-account-chip', standalone: true, template: '' })
class CopilotAccountChipStubComponent {
  @Input() provider: string | null = null;
  @Input() workingDirectory: string | null = null;
  @Output() blocked = new EventEmitter<boolean>();
  @Output() accountResolved = new EventEmitter<string | null>();
}

@Component({ selector: 'app-provider-account-chip', standalone: true, template: '' })
class ProviderAccountChipStubComponent {
  @Input() provider: string | null = null;
  @Input() model: string | null = null;
  @Input() executionNodeId: string | null = null;
  @Input() chosenProfileId: string | null = null;
  @Output() accountChosen = new EventEmitter<string | null>();
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
  let draftService: ReturnType<typeof createDraftServiceMock>;
  let newSessionDraft: ReturnType<typeof createNewSessionDraftMock>;
  const appSettings = signal({ providerSignalFenceEnabled: true });
  let providerState: ReturnType<typeof createProviderStateMock>;
  let animationFrameCallbacks: FrameRequestCallback[];

  beforeEach(async () => {
    codebaseSearch = createCodebaseSearchMock();
    draftService = createDraftServiceMock();
    newSessionDraft = createNewSessionDraftMock();
    providerState = createProviderStateMock();
    animationFrameCallbacks = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      animationFrameCallbacks.push(callback);
      return animationFrameCallbacks.length;
    }));

    TestBed.resetTestingModule();
    TestBed.overrideComponent(InputPanelComponent, {
      set: {
        template: inputPanelTemplate,
        templateUrl: undefined,
        styles: [inputPanelStyles],
        styleUrl: undefined,
        styleUrls: [],
        imports: [
          AioTooltipDirective,
          InlineHintComponent,
          AppIconButtonDirective,
          AgentSelectorStubComponent,
          CompactModelPickerStubComponent,
          ComposerBannersStubComponent,
          ComposerRecoveryBannerComponent,
          RunReadinessBannerComponent,
          LoopToggleStubComponent,
          LoopConfigPanelStubComponent,
          ComposerToolbarStubComponent,
          QuickAskPanelStubComponent,
          ColdCacheChipStubComponent,
          ComposerQuotaNoticeComponent,
          ComposerQueueStubComponent,
          ComposerAutocompleteComponent,
          ImageLightboxStubComponent,
          CopilotAccountChipStubComponent,
          ProviderAccountChipStubComponent,
        ],
      },
    });

    await TestBed.configureTestingModule({
      imports: [InputPanelComponent],
      providers: [
        { provide: CommandStore, useValue: createCommandStoreMock() },
        { provide: DraftService, useValue: draftService },
        { provide: PromptSuggestionService, useValue: { getSuggestion: vi.fn(() => null) } },
        { provide: PerfInstrumentationService, useValue: { markComposerLatency: vi.fn(() => vi.fn()) } },
        { provide: ProviderStateService, useValue: providerState },
        { provide: NewSessionDraftService, useValue: newSessionDraft },
        { provide: SettingsStore, useValue: { defaultYoloMode: signal(false), settings: appSettings } },
        { provide: ActionDispatchService, useValue: { dispatch: vi.fn() } },
        { provide: InstanceStore,
          useValue: { getInstance: vi.fn(() => undefined), isQueueParked: () => false },
         },
        { provide: ProviderQuotaStore, useValue: { snapshots: signal({}), accountSnapshots: signal([]) } },
        {
          provide: KeybindingService,
          useValue: { setContext: vi.fn(), onAction: vi.fn(() => vi.fn()), formatBindingByAction: () => 'Live binding', ariaShortcutsByAction: () => 'Control+Enter' },
        },
        { provide: OrchestrationIpcService, useValue: createOrchestrationIpcMock() },
        { provide: AppIpcService, useValue: { getStartupCapabilities: vi.fn(async () => null) } },
        { provide: ElectronIpcService, useValue: { platform: 'darwin' } },
        { provide: PromptHistoryStore, useValue: createPromptHistoryStoreMock() },
        { provide: VoiceConversationStore, useValue: createVoiceConversationStoreMock() },
        { provide: ColdCacheResumeService, useValue: { shouldCompactFirst: () => false, phaseFor: () => 'idle' } },
        { provide: CodebaseIpcService, useValue: { search: codebaseSearch } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(InputPanelComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('instanceId', 'inst-1');
    fixture.componentRef.setInput('workingDirectory', '/repo');
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('restores cancelled queue text before the existing text and keeps an edit stash', () => {
    component.message.set('Existing draft'); component.restoreTextToComposer('Cancelled'); fixture.detectChanges();
    expect(component.message()).toBe('Cancelled\n\nExisting draft');
    expect(draftService.getDraft('inst-1')).toBe('Cancelled\n\nExisting draft');
    const internal = component as unknown as { stashedDraft: ReturnType<typeof signal<string | null>>; editMessageIndex: ReturnType<typeof signal<number | null>> };
    internal.stashedDraft.set('Stashed'); internal.editMessageIndex.set(3); component.editMode.set(true); component.message.set('Edited text');
    component.restoreTextToComposer('Another cancelled'); fixture.detectChanges();
    expect(component.message()).toBe('Another cancelled\n\nEdited text\n\nStashed'); expect(internal.stashedDraft()).toBe('Stashed');
    expect(component.editMode()).toBe(false); expect(internal.editMessageIndex()).toBeNull();
  });
  it('preserves the hidden draft while restoring during prompt-history recall', () => {
    const internals = component as unknown as { recallIndex: ReturnType<typeof signal<number | null>>; stashKey: () => string };
    const stash = internals.stashKey();
    draftService.drafts.set(stash, 'Unsent original'); internals.recallIndex.set(0); component.message.set('Recalled question');
    component.restoreTextToComposer('Table rows', 'append'); fixture.detectChanges();
    expect(component.message()).toBe('Recalled question\n\nUnsent original\n\nTable rows');
    expect(draftService.drafts.get(stash)).toBe('Unsent original'); expect(internals.recallIndex()).toBeNull();
  });
  it.each(['idle', 'busy', 'initializing', 'respawning'] as const)('renders a single hint for %s', (status) => {
    fixture.componentRef.setInput('instanceStatus', status); fixture.componentRef.setInput('isBusy', status === 'busy');
    fixture.componentRef.setInput('isRespawning', status === 'respawning'); fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.input-hints .hint')).toHaveLength(1);
  });

  it('recalculates textarea height when restoring drafts across sessions', () => {
    flushAnimationFrames();
    const textarea = getTextarea();
    const measuredFromHeights: string[] = [];
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      get: () => {
        measuredFromHeights.push(textarea.style.height);
        return textarea.value ? 298 : 51;
      },
    });

    draftService.drafts.set('inst-long', 'Long restored draft');
    fixture.componentRef.setInput('instanceId', 'inst-long');
    fixture.detectChanges();
    flushAnimationFrames();

    expect(textarea.value).toBe('Long restored draft');
    expect(textarea.style.height).toBe('220px');
    expect(measuredFromHeights.at(-1)).toBe('auto');

    fixture.componentRef.setInput('instanceId', 'inst-short');
    fixture.detectChanges();
    flushAnimationFrames();

    expect(textarea.value).toBe('');
    expect(textarea.style.height).toBe('51px');
    expect(measuredFromHeights.at(-1)).toBe('auto');
  });

  it('shows the active session account quota inside the input hints', () => {
    const instance = { id: 'inst-quota', provider: 'claude', currentModel: 'claude-sonnet-4-6', accountProfileId: 'seat-a' };
    vi.mocked(TestBed.inject(InstanceStore).getInstance).mockReturnValue(instance as never);
    const quota = TestBed.inject(ProviderQuotaStore);
    const snapshot: ProviderQuotaSnapshot = { provider: 'claude', accountProfileId: 'seat-a', ok: true,
      takenAt: Date.now(), source: 'admin-api', windows: [{ id: 'claude.5h', label: '5-hour', kind: 'rolling-window',
        used: 82, limit: 100, remaining: 18, unit: 'percent', resetsAt: null }] };
    (quota.accountSnapshots as ReturnType<typeof signal<ProviderQuotaSnapshot[]>>).set([snapshot]);
    fixture.componentRef.setInput('instanceId', 'inst-quota');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.input-hints app-composer-quota-notice')?.textContent)
      .toContain('Claude 5-hour limit: 18% left');
    fixture.componentRef.setInput('instanceId', 'new');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-composer-quota-notice')).toBeNull();
  });

  it('shows the draft posture in visible words beneath Auto-approve', () => {
    fixture.componentRef.setInput('instanceId', 'new');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.yolo-toggle')?.textContent).toContain('Auto-approve: off');
    expect(fixture.nativeElement.querySelector('.draft-posture')?.textContent)
      .toContain('This session will: Asks before acting');
    newSessionDraft.yoloMode.set(true);
    newSessionDraft.hardened.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.draft-posture')?.textContent)
      .toContain('Acts without asking · edits only inside this folder · web allowed');
  });

  it('says in the hint that a queued message sends after compaction, without naming another provider', () => {
    fixture.componentRef.setInput('provider', 'claude');
    fixture.componentRef.setInput('isCompacting', true);
    fixture.componentRef.setInput('queuedCount', 1);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.input-hints')?.textContent).toContain('Compacting the conversation');
    expect(fixture.nativeElement.querySelector('.input-hints')?.textContent).not.toContain('Codex');
  });

  describe('focus requests from opening a session', () => {
    it('puts the caret at the end of this session\'s message box', () => {
      draftService.drafts.set('inst-1', 'Half-written note');
      draftService.textVersion.update((v) => v + 1);
      fixture.detectChanges();

      TestBed.inject(ComposerFocusService).request('inst-1');
      fixture.detectChanges();

      const textarea = getTextarea();
      expect(document.activeElement).toBe(textarea);
      expect(textarea.selectionStart).toBe('Half-written note'.length);
      expect(TestBed.inject(ComposerFocusService).pending()).toBeNull();
    });

    it('leaves a request for another session pending and does not take focus', () => {
      const focus = TestBed.inject(ComposerFocusService);
      focus.request('inst-2');
      fixture.detectChanges();

      expect(document.activeElement).not.toBe(getTextarea());
      expect(focus.pending()).toEqual({ target: 'inst-2' });
    });

    it('focuses once the shared message box switches to the requested session', () => {
      TestBed.inject(ComposerFocusService).request('inst-2');
      fixture.detectChanges();
      fixture.componentRef.setInput('instanceId', 'inst-2');
      fixture.detectChanges();

      expect(document.activeElement).toBe(getTextarea());
    });

    it('does not focus a disabled message box', () => {
      fixture.componentRef.setInput('disabled', true);
      fixture.detectChanges();
      TestBed.inject(ComposerFocusService).request('inst-1');
      fixture.detectChanges();

      expect(document.activeElement).not.toBe(getTextarea());
    });
  });

  it('resizes the latest textarea when the composer remounts with a restored draft', () => {
    flushAnimationFrames();
    fixture.destroy();
    draftService.drafts.set('inst-remounted', 'Restored after remount');

    fixture = TestBed.createComponent(InputPanelComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('instanceId', 'inst-remounted');
    fixture.componentRef.setInput('workingDirectory', '/repo');
    fixture.detectChanges();

    const textarea = getTextarea();
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      value: 298,
    });

    expect(textarea.value).toBe('Restored after remount');
    flushAnimationFrames();
    expect(textarea.style.height).toBe('220px');
  });

  it('coalesces resize requests onto the latest textarea element', () => {
    flushAnimationFrames();
    const firstTextarea = document.createElement('textarea');
    const latestTextarea = document.createElement('textarea');
    Object.defineProperty(firstTextarea, 'scrollHeight', {
      configurable: true,
      value: 120,
    });
    Object.defineProperty(latestTextarea, 'scrollHeight', {
      configurable: true,
      value: 180,
    });
    const resize = component as unknown as {
      scheduleTextareaResize(textarea: HTMLTextAreaElement): void;
    };

    resize.scheduleTextareaResize(firstTextarea);
    resize.scheduleTextareaResize(latestTextarea);
    expect(animationFrameCallbacks).toHaveLength(1);
    flushAnimationFrames();

    expect(firstTextarea.style.height).toBe('');
    expect(latestTextarea.style.height).toBe('180px');
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

  // `cancel-operation` is a document-level global Escape binding whose cascade
  // interrupts the running instance, and KeybindingService's input-element
  // guard does not exempt Escape typed in a textarea. So an Escape this
  // component handles locally must stop propagating, or dismissing a composer
  // affordance also kills the in-flight turn. All four such branches route
  // through `consumeLocalEscape`; these cover both ends of that helper plus
  // the fall-through that must NOT be swallowed.
  it('does not let an edit-mode Escape reach the document-level cancel binding', () => {
    const { seen, dispose } = captureDocumentKeydown();

    try {
      component.editMode.set(true);
      fixture.detectChanges();

      getTextarea().dispatchEvent(keydown('Escape'));
      fixture.detectChanges();

      expect(component.editMode()).toBe(false);
      expect(seen).toEqual([]);

      // Drain the textarea-restore frame `cancelEditMode()` schedules so it
      // does not fire after the environment is torn down.
      flushAnimationFrames();
    } finally {
      dispose();
    }
  });

  describe('editing the last sent message', () => {
    const conversation: OutputMessage[] = [
      { id: 'user-1', timestamp: 1, type: 'user', content: 'First question' },
      { id: 'assistant-1', timestamp: 2, type: 'assistant', content: 'First answer' },
      { id: 'user-2', timestamp: 3, type: 'user', content: 'Second question' },
      { id: 'assistant-2', timestamp: 4, type: 'assistant', content: 'Second answer' },
      { id: 'tool-1', timestamp: 5, type: 'tool_use', content: 'tool call' },
    ];

    function typeDraft(value: string, caret = value.length): void {
      const textarea = getTextarea();
      textarea.value = value;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.setSelectionRange(caret, caret);
      fixture.detectChanges();
    }

    function press(key: string): boolean {
      const handled = !getTextarea().dispatchEvent(keydown(key));
      fixture.detectChanges();
      return handled;
    }

    function banner(): string | null {
      return fixture.nativeElement.querySelector('.edit-mode-bar')?.textContent?.trim() ?? null;
    }

    it('loads the last user message on Up from the start of the composer, and only then', () => {
      fixture.componentRef.setInput('outputMessages', conversation.filter(m => m.type !== 'user'));
      typeDraft('', 0);
      expect(press('ArrowUp')).toBe(false);
      expect(banner()).toBeNull();

      fixture.componentRef.setInput('outputMessages', conversation);
      typeDraft('my draft');
      expect(press('ArrowUp')).toBe(false);
      expect(banner()).toBeNull();
      expect(component.message()).toBe('my draft');

      getTextarea().setSelectionRange(0, 0);
      expect(press('ArrowUp')).toBe(true);
      expect(banner()).toBe('Editing last message');
      expect(component.message()).toBe('Second question');
      flushAnimationFrames();
      expect(getTextarea().value).toBe('Second question');
      expect(getTextarea().selectionStart).toBe('Second question'.length);
    });

    it('restores the earlier draft on Escape, even after Up is pressed again while editing', () => {
      fixture.componentRef.setInput('outputMessages', conversation);
      typeDraft('my draft', 0);
      press('ArrowUp');
      flushAnimationFrames();
      getTextarea().setSelectionRange(0, 0);
      press('ArrowUp');
      expect(component.message()).toBe('Second question');

      expect(press('Escape')).toBe(true);
      flushAnimationFrames();
      expect(banner()).toBeNull();
      expect(component.message()).toBe('my draft');
      expect(getTextarea().value).toBe('my draft');
    });

    it('keeps the earlier draft saved while the loaded message is changed, and shows it again on Escape', () => {
      fixture.componentRef.setInput('outputMessages', conversation);
      typeDraft('my draft', 0);
      press('ArrowUp');
      flushAnimationFrames();

      typeDraft('Second question, half reworded');
      expect(component.message()).toBe('Second question, half reworded');
      expect(draftService.getDraft('inst-1')).toBe('my draft');

      expect(press('Escape')).toBe(true);
      flushAnimationFrames();
      expect(banner()).toBeNull();
      expect(component.message()).toBe('my draft');
      expect(getTextarea().value).toBe('my draft');
      expect(draftService.getDraft('inst-1')).toBe('my draft');
    });

    it('resends the edited text as a replacement for that message on Enter, even while busy', () => {
      const resent: unknown[] = [];
      const sent: string[] = [];
      component.resendEdited.subscribe(event => resent.push(event));
      component.sendMessage.subscribe(text => sent.push(text));
      fixture.componentRef.setInput('isBusy', true);
      fixture.componentRef.setInput('outputMessages', conversation);
      typeDraft('', 0);
      press('ArrowUp');
      flushAnimationFrames();

      typeDraft('   ');
      expect(press('Enter')).toBe(true);
      expect(resent).toEqual([]);
      expect(banner()).toBe('Editing last message');

      typeDraft('  Second question, reworded  ');
      expect(press('Enter')).toBe(true);
      expect(resent).toEqual([{
        messageIndex: 2,
        messageId: 'user-2',
        text: '  Second question, reworded  ',
        attachments: undefined,
        retryMode: 'transcript-only',
      }]);
      expect(sent).toEqual([]);
      expect(banner()).toBeNull();
      expect(component.message()).toBe('');
      expect(draftService.getDraft('inst-1')).toBe('');
    });

    it('leaves edit mode when the user switches to another session', () => {
      draftService.drafts.set('inst-2', 'Draft on the other session');
      fixture.componentRef.setInput('outputMessages', conversation);
      typeDraft('', 0);
      press('ArrowUp');
      flushAnimationFrames();
      expect(banner()).toBe('Editing last message');

      fixture.componentRef.setInput('instanceId', 'inst-2');
      fixture.detectChanges();
      flushAnimationFrames();
      expect(banner()).toBeNull();
      expect(component.message()).toBe('Draft on the other session');

      // Escape now belongs to the new session: there is no edit to cancel.
      expect(press('Escape')).toBe(false);
      expect(component.message()).toBe('Draft on the other session');
    });

    it('shows the earlier draft, not the half-edited message, on returning to a session left while editing', () => {
      fixture.componentRef.setInput('outputMessages', conversation);
      typeDraft('my draft', 0);
      press('ArrowUp');
      flushAnimationFrames();
      typeDraft('Second question, half reworded');

      fixture.componentRef.setInput('instanceId', 'inst-2');
      fixture.detectChanges();
      fixture.componentRef.setInput('instanceId', 'inst-1');
      fixture.detectChanges();
      flushAnimationFrames();
      expect(banner()).toBeNull();
      expect(component.message()).toBe('my draft');
    });
  });

  it('does not let a ghost-text Escape reach the document-level cancel binding', async () => {
    await typeInComposer('');
    component.ghostSuggestion.set('git status');
    fixture.detectChanges();
    expect(component.showGhostText()).toBe(true);

    const { seen, dispose } = captureDocumentKeydown();
    try {
      getTextarea().dispatchEvent(keydown('Escape'));
      fixture.detectChanges();

      expect(component.showGhostText()).toBe(false);
      expect(seen).toEqual([]);
    } finally {
      dispose();
    }
  });

  it('still lets a bare Escape through so it can stop the running turn', () => {
    const { seen, dispose } = captureDocumentKeydown();

    try {
      // Nothing open, nothing to dismiss: the global stop shortcut must work.
      getTextarea().dispatchEvent(keydown('Escape'));
      fixture.detectChanges();

      expect(seen).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it('dismisses the wakeup popover on Escape without reaching the cancel binding', () => {
    // This one is registered in the capture phase: both this handler and
    // KeybindingService's live on `document`, where stopPropagation cannot
    // order them.
    const { seen, dispose } = captureDocumentKeydown();

    try {
      component.showWakeupMenu.set(true);
      fixture.detectChanges();

      document.dispatchEvent(keydown('Escape'));
      fixture.detectChanges();

      expect(component.showWakeupMenu()).toBe(false);
      expect(seen).toEqual([]);
    } finally {
      dispose();
    }
  });

  it('shows and toggles the selected provider fast preference for a new session', () => {
    fixture.componentRef.setInput('instanceId', 'new');
    fixture.detectChanges();

    const fastButton = fixture.nativeElement.querySelector('.fast-toggle') as HTMLButtonElement;
    expect(fastButton.textContent).toContain('Fast: off');

    fastButton.click();
    fixture.detectChanges();

    expect(providerState.rememberFastModeForProvider).toHaveBeenCalledWith('claude', true);
    expect(fastButton.textContent).toContain('Fast: on');
  });

  it('explains new-session toggles and an empty Send on hover, not as text under the composer', () => {
    fixture.componentRef.setInput('instanceId', 'new');
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toContain('auto-approve all actions');
    expect(text).not.toContain('will prompt for approvals');
    expect(text).not.toContain('Click to enable faster output');
    expect(text).not.toContain('Write a message or attach a file or folder before sending');
    expect(hintFor('.fast-toggle').appTooltip()).toBe('Faster replies at some capability cost. Click to enable');
    expect(hintFor('.btn-send').appTooltipDisabledReason()).toBe('Write a message or attach a file or folder before sending');
  });

  it('shows the remembered fast preference only for supported draft providers', () => {
    fixture.componentRef.setInput('instanceId', 'new');
    providerState.fastModeByProvider.set({ claude: false, codex: true });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.fast-toggle')?.textContent).toContain('Fast: off');

    providerState.selectedProvider.set('codex');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.fast-toggle')?.textContent).toContain('Fast: on');

    providerState.selectedProvider.set('gemini');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.fast-toggle')).toBeNull();
  });

  it('hides the draft fast toggle for a local-model target', () => {
    fixture.componentRef.setInput('instanceId', 'new');
    newSessionDraft.provider.set('auto');
    newSessionDraft.modelRuntimeTarget.set({
      kind: 'local-model',
      source: 'this-device',
      selectorId: 'lm://this-device/ollama/ollama/qwen2.5',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'qwen2.5',
    });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.fast-toggle')).toBeNull();
  });

  it('does not promise a Hardened boundary for an unsupported saved draft', () => {
    fixture.componentRef.setInput('instanceId', 'new');
    newSessionDraft.provider.set('gemini'); newSessionDraft.hardened.set(true);
    fixture.detectChanges();
    expect(component.draftPostureSentence()).not.toContain('edits only inside this folder');
    expect(component.draftPostureSentence()).toContain('can edit files');
    expect(fixture.nativeElement.querySelector('.draft-posture')?.textContent).toContain('can edit files');
    expect(fixture.nativeElement.querySelector('.draft-posture')?.textContent).not.toContain('edits only inside this folder');
    expect(component.hardenedLabel()).toBe('not available for Gemini');
    expect(newSessionDraft.hardened()).toBe(true);
    newSessionDraft.provider.set('claude'); fixture.detectChanges();
    expect(component.draftPostureSentence()).toContain('edits only inside this folder');
  });
  it('marks Hardened unavailable for a provider with no jail support, but still lets it be turned off', () => {
    fixture.componentRef.setInput('instanceId', 'new');
    newSessionDraft.provider.set('claude');
    fixture.detectChanges();
    expect(component.hardenedUnavailable()).toBe(false);
    expect(component.hardenedLabel()).toBe('off');

    newSessionDraft.provider.set('gemini');
    fixture.detectChanges();
    expect(component.hardenedUnavailable()).toBe(true);
    expect(component.hardenedLabel()).toBe('not available for Gemini');
    let hardenedButton = fixture.nativeElement.querySelector('.hardened-toggle') as HTMLButtonElement;
    expect(hardenedButton.disabled).toBe(false);
    expect(hardenedButton.getAttribute('aria-disabled')).toBe('true');
    expect(hardenedButton.textContent).toContain('Hardened: not available for Gemini');
    expect(hintFor('.hardened-toggle').appTooltipDisabledReason()).toContain('not supported for Gemini yet');
    hardenedButton.click();
    expect(newSessionDraft.setHardened).not.toHaveBeenCalled();

    // A folder that remembered Hardened ON must show it and allow switching it off.
    newSessionDraft.hardened.set(true);
    fixture.detectChanges();
    expect(component.hardenedLabel()).toBe('not available for Gemini');
    expect(component.hardenedTitle()).toContain('Click to turn it off');
    hardenedButton = fixture.nativeElement.querySelector('.hardened-toggle') as HTMLButtonElement;
    expect(hardenedButton.disabled).toBe(false);
    expect(hardenedButton.textContent).toContain('Hardened: not available for Gemini');
    hardenedButton.click();
    expect(newSessionDraft.setHardened).toHaveBeenCalledWith(null);

    // Auto is decided at spawn, so it is not flagged here.
    newSessionDraft.provider.set('auto');
    fixture.detectChanges();
    expect(component.hardenedUnavailable()).toBe(false);
    expect((fixture.nativeElement.querySelector('.hardened-toggle') as HTMLButtonElement).disabled).toBe(false);
  });

  it('toggles the per-session signal fence and explains when it is locked', () => {
    fixture.componentRef.setInput('instanceId', 'new');
    newSessionDraft.provider.set('claude');
    fixture.detectChanges();
    const fenceButton = () => fixture.nativeElement.querySelector('.fence-toggle') as HTMLButtonElement;
    expect(fenceButton().textContent).toContain('Fence ON');
    expect(fenceButton().disabled).toBe(false);
    fenceButton().click();
    expect(newSessionDraft.setSignalFenceOff).toHaveBeenCalledWith(true);

    newSessionDraft.signalFenceOff.set(true);
    fixture.detectChanges();
    expect(fenceButton().textContent).toContain('Fence OFF');
    expect(hintFor('.fence-toggle').appTooltip()).toContain('can stop any program you own');

    // A hardened jail always blocks cross-session signals.
    newSessionDraft.hardened.set(true);
    fixture.detectChanges();
    expect(fenceButton().textContent).toContain('Fence ON');
    expect(fenceButton().disabled).toBe(false);
    expect(fenceButton().getAttribute('aria-disabled')).toBe('true');
    newSessionDraft.hardened.set(null);

    // The Settings switch turns it off for every session.
    newSessionDraft.signalFenceOff.set(false);
    appSettings.set({ providerSignalFenceEnabled: false });
    fixture.detectChanges();
    try {
      expect(fenceButton().textContent).toContain('Fence OFF');
      expect(fenceButton().disabled).toBe(false);
    expect(fenceButton().getAttribute('aria-disabled')).toBe('true');
      expect(hintFor('.fence-toggle').appTooltipDisabledReason()).toContain('Settings');
    } finally {
      appSettings.set({ providerSignalFenceEnabled: true });
    }
  });

  it('explains that a queued Codex message will send after provider compaction', () => {
    fixture.componentRef.setInput('provider', 'codex');
    fixture.componentRef.setInput('isBusy', true);
    fixture.componentRef.setInput('isCompacting', true);
    fixture.componentRef.setInput('queuedCount', 1);
    fixture.detectChanges();

    const hints = fixture.nativeElement.querySelector('.input-hints')?.textContent ?? '';
    expect(hints).toContain('Compacting the conversation');
    expect(hints).not.toContain('Codex');
    expect(hints).toContain('your message will send afterwards');
    expect(hints).not.toContain('Esc interrupts');
  });

  it('opens quick ask from the live toolbar and closes it when the selected session changes', () => {
    const usage: ContextUsage = { used: 120_000, total: 200_000, percentage: 60,
      occupancyReported: true, occupancyIsAggregate: true };
    fixture.componentRef.setInput('contextUsage', usage);
    const toolbar = fixture.debugElement.query(By.directive(ComposerToolbarStubComponent));
    expect(toolbar).toBeDefined();
    (toolbar!.componentInstance as ComposerToolbarStubComponent).quickAskRequested.emit();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.quick-ask-test')).not.toBeNull();
    const quickAsk = fixture.debugElement.query(By.directive(QuickAskPanelStubComponent))
      .componentInstance as QuickAskPanelStubComponent;
    expect(quickAsk.contextUsage).toBe(usage);
    fixture.componentRef.setInput('contextUsage', undefined);
    fixture.detectChanges();
    expect(quickAsk.contextUsage).toBeNull();

    fixture.componentRef.setInput('instanceId', 'inst-2');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.quick-ask-test')).toBeNull();
  });

  it('forwards resident and remote session flags to the bound composer toolbar', () => {
    fixture.componentRef.setInput('residentClaude', true);
    fixture.componentRef.setInput('remoteExecution', true);
    fixture.detectChanges();
    const toolbar = fixture.debugElement.query(By.directive(ComposerToolbarStubComponent))
      .componentInstance as ComposerToolbarStubComponent;
    expect(toolbar.residentClaude).toBe(true);
    expect(toolbar.remoteExecution).toBe(true);

    fixture.componentRef.setInput('residentClaude', false);
    fixture.componentRef.setInput('remoteExecution', false);
    fixture.detectChanges();
    expect(toolbar.residentClaude).toBe(false);
    expect(toolbar.remoteExecution).toBe(false);
  });

  it('binds the active session to both banners and the send tooltip', () => {
    const banners = fixture.debugElement.query(By.directive(ComposerBannersStubComponent))
      .componentInstance as ComposerBannersStubComponent;
    const readiness = fixture.debugElement.query(By.directive(RunReadinessBannerComponent))
      .componentInstance as RunReadinessBannerComponent;
    const sendButton = fixture.debugElement.query(By.css('.btn-send'));

    expect(banners.instanceId).toBe('inst-1');
    expect(banners.instanceStatus).toBe('idle');
    expect(readiness.instanceId()).toBe('inst-1');
    expect(readiness.reasons()).toEqual([]);
    expect(sendButton.injector.get(AioTooltipDirective).appTooltip()).toBe('Send message');

    fixture.componentRef.setInput('instanceId', 'inst-2');
    fixture.detectChanges();
    expect(banners.instanceId).toBe('inst-2');
    expect(readiness.instanceId()).toBe('inst-2');
  });

  function hintFor(selector: string): AioTooltipDirective {
    return fixture.debugElement.query(By.css(selector)).injector.get(AioTooltipDirective);
  }

  it('names the message, wake-up and unavailable voice controls and opens their real hints on focus', () => {
    fixture.componentRef.setInput('instanceId', 'new');
    fixture.componentRef.setInput('showWakeupControls', true);
    fixture.detectChanges();
    expect(getTextarea().getAttribute('aria-label')).toBe('Message');
    const wakeup = fixture.nativeElement.querySelector('.btn-wakeup') as HTMLButtonElement;
    expect(wakeup.getAttribute('aria-label')).toBe('Schedule session wakeup');
    expect(hintFor('.btn-wakeup')).toBeDefined();
    const voice = fixture.nativeElement.querySelector('.btn-voice') as HTMLButtonElement;
    expect(voice.getAttribute('aria-label')).toBe('Start voice conversation');
    expect(voice.disabled).toBe(false);
    expect(voice.getAttribute('aria-disabled')).toBe('true');
    const original = voice.matches.bind(voice);
    vi.spyOn(voice, 'matches').mockImplementation(selector => selector === ':focus-visible' || original(selector));
    voice.dispatchEvent(new FocusEvent('focus'));
    fixture.detectChanges();
    expect(document.getElementById(voice.getAttribute('aria-describedby')!)?.textContent).toContain('Start a session before using voice');
    voice.click();
    expect(TestBed.inject(VoiceConversationStore).start).not.toHaveBeenCalled();
    voice.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(voice.hasAttribute('aria-describedby')).toBe(false);
    expect(fixture.nativeElement.querySelectorAll('[title]')).toHaveLength(0);
  });

  it('keeps empty Send focusable with a reason and blocks activation before sending real content', async () => {
    const sent: string[] = [];
    component.sendMessage.subscribe(text => sent.push(text));
    const send = fixture.nativeElement.querySelector('.btn-send') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    expect(send.getAttribute('aria-disabled')).toBe('true');
    expect(send.getAttribute('aria-label')).toBe('Send message');
    expect(hintFor('.btn-send').appTooltipShortcut()).toBe('send-message');
    send.click();
    await fixture.whenStable();
    expect(sent).toEqual([]);
    await typeInComposer('a real message');
    expect(send.hasAttribute('aria-disabled')).toBe(false);
    send.click();
    await fixture.whenStable();
    expect(sent).toEqual(['a real message']);
    fixture.componentRef.setInput('isBusy', true);
    fixture.detectChanges();
    expect(hintFor('.btn-stop').appTooltip()).toBe('Stop current turn');
    expect(hintFor('.btn-stop').appTooltipShortcut()).toBe('cancel-operation');
  });

  it('keeps attachment preview, full name and removal hints on separate hosts', () => {
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:test-preview', revokeObjectURL: vi.fn() });
    fixture.componentRef.setInput('pendingFiles', [new File(['image'], 'long-image-name.png', { type: 'image/png' }), new File(['text'], 'note.txt')]);
    fixture.detectChanges();
    const hints = fixture.debugElement.queryAll(By.directive(AioTooltipDirective));
    for (const hint of hints) {
      expect(hint.nativeElement.querySelector('[appTooltip], [appIconButton]')).toBeNull();
    }
    expect(fixture.nativeElement.querySelectorAll('.file-preview-trigger')).toHaveLength(4);
    expect(hintFor('.file-preview-trigger').appTooltip()).toBe('Click to preview');
    expect(fixture.nativeElement.querySelector('.file-name')?.closest('button')?.tabIndex).toBe(0);
  });

  it('previews attachments when their filename is activated and retains native keyboard button semantics', () => {
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:test-preview', revokeObjectURL: vi.fn() });
    const files = [new File(['image'], 'picture.png', { type: 'image/png' }), new File(['text'], 'note.txt')];
    fixture.componentRef.setInput('pendingFiles', files);
    fixture.detectChanges();
    const preview = vi.spyOn(component, 'openLightbox');
    const names = fixture.nativeElement.querySelectorAll('.file-name') as NodeListOf<HTMLElement>;
    names.forEach((name, index) => {
      const button = name.closest('button');
      expect(button, 'filename must belong to a native preview button for Enter/Space activation').not.toBeNull();
      expect(button!.type).toBe('button');
      expect(button!.tabIndex).toBe(0);
      expect(button!.getAttribute('aria-label')).toBe('Preview ' + files[index].name);
      name.click();
      expect(preview).toHaveBeenLastCalledWith(files[index]);
    });
    expect(preview).toHaveBeenCalledTimes(2);
    fixture.nativeElement.querySelector('.file-size').click();
    expect(preview).toHaveBeenCalledTimes(3);
  });

  it('shows progress on the natively disabled Steer button while a loop is starting', () => {
    fixture.componentRef.setInput('instanceStatus', 'busy');
    component.message.set('continue');
    component.loopStarting.set(true);
    fixture.detectChanges();
    const steer = fixture.nativeElement.querySelector('.btn-steer') as HTMLButtonElement;
    expect(steer.disabled).toBe(true);
    expect(steer.textContent).toContain('Starting loop…');
    expect(steer.getAttribute('aria-label')).toBe('Starting loop…');
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

  /** Bubble-phase document keydown recorder — stands in for KeybindingService. */
  function captureDocumentKeydown(): { seen: KeyboardEvent[]; dispose: () => void } {
    const seen: KeyboardEvent[] = [];
    const listener = (event: Event) => seen.push(event as KeyboardEvent);
    document.addEventListener('keydown', listener);
    return { seen, dispose: () => document.removeEventListener('keydown', listener) };
  }

  function flushAnimationFrames(): void {
    while (animationFrameCallbacks.length > 0) {
      animationFrameCallbacks.shift()!(0);
    }
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

function createDraftServiceMock() {
  const textVersion = signal(0);
  const drafts = new Map<string, string>();
  return {
    drafts,
    textVersion,
    getDraft: vi.fn((contextKey: string) => drafts.get(contextKey) ?? ''),
    setDraft: vi.fn((contextKey: string, value: string) => {
      if (value) {
        drafts.set(contextKey, value);
      } else {
        drafts.delete(contextKey);
      }
    }),
    clearDraft: vi.fn((contextKey: string) => {
      drafts.delete(contextKey);
    }),
  };
}

function createProviderStateMock() {
  const fastModeByProvider = signal<Record<string, boolean>>({});
  return {
    selectedProvider: signal<ProviderType>('claude'),
    selectedModel: signal<string>(''),
    fastModeByProvider,
    setProvider: vi.fn(),
    setModel: vi.fn(),
    getFastModeForProvider: vi.fn(
      (provider: ProviderType) => fastModeByProvider()[provider] ?? false,
    ),
    rememberFastModeForProvider: vi.fn((provider: ProviderType, fastMode: boolean) => {
      fastModeByProvider.update((current) => ({ ...current, [provider]: fastMode }));
    }),
    getLaunchModeForProvider: vi.fn(() => 'orchestrated' as const),
  };
}

function createNewSessionDraftMock() {
  return {
    revision: signal(0),
    activeKey: signal('__default__'),
    prompt: signal(''),
    provider: signal<ProviderType | null>(null),
    model: signal<string | null>(null),
    modelRuntimeTarget: signal<ModelRuntimeTarget | null>(null),
    reasoningEffort: signal(null),
    nodeId: signal<string | null>(null),
    yoloMode: signal<boolean | null>(null),
    hardened: signal<boolean | null>(null),
    signalFenceOff: signal(false),
    setSignalFenceOff: vi.fn(),
    launchMode: signal(null),
    agentId: signal('build'),
    accountProfileId: signal<string | null>(null),
    setAccountProfileId: vi.fn(),
    setProvider: vi.fn(),
    setModel: vi.fn(),
    setModelRuntimeTarget: vi.fn(),
    setReasoningEffort: vi.fn(),
    setAgentId: vi.fn(),
    setYoloMode: vi.fn(),
    setHardened: vi.fn(),
    setLaunchMode: vi.fn(),
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
