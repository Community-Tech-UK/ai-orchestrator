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
import { By } from '@angular/platform-browser';
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
import type { InstanceWaitReason } from '../../../../shared/types/instance.types';
import { InputPanelComponent } from './input-panel.component';

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
  @Input() waitReason: InstanceWaitReason | undefined = undefined;
  @Input() canSteer = false;
  @Input() parked = false;
  @Output() editMessage = new EventEmitter<number>();
  @Output() steerMessage = new EventEmitter<number>();
  @Output() cancelMessage = new EventEmitter<number>();
  @Output() resumeQueue = new EventEmitter<void>();
}
@Component({ selector: 'app-interrupted-continuation', standalone: true, template: '' })
class InterruptedContinuationStub {
  @Input() instanceId = '';
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

const backoff: InstanceWaitReason = { kind: 'backoff', attempt: 2, retryAt: 1_000 };

describe('InputPanelComponent continue button, queue reason and compaction wording', () => {
  let fixture: ComponentFixture<InputPanelComponent>;
  let component: InputPanelComponent;

  const continuation = () => fixture.debugElement.query(By.directive(InterruptedContinuationStub));
  const queue = () => fixture.debugElement.query(By.directive(ComposerQueueStub));
  const hints = () => Array.from<HTMLElement>(fixture.nativeElement.querySelectorAll('.hint')).map((hint) => hint.textContent?.trim());

  function set(name: string, value: unknown): void {
    fixture.componentRef.setInput(name, value);
    fixture.detectChanges();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal('URL', Object.assign(globalThis.URL, {
      createObjectURL: vi.fn(() => 'blob:preview'),
      revokeObjectURL: vi.fn(),
    }));
    TestBed.resetTestingModule();
    TestBed.overrideComponent(InputPanelComponent, {
      set: {
        template,
        templateUrl: undefined,
        styles: [styles],
        styleUrl: undefined,
        styleUrls: [],
        imports: [
          AgentSelectorStub, LoopToggleStub, LoopConfigPanelStub, ComposerToolbarStub, ComposerQueueStub,
          ComposerAutocompleteStub, ImageLightboxStub, InterruptedContinuationStub,
        ],
      },
    });
    await TestBed.configureTestingModule({
      imports: [InputPanelComponent],
      providers: [
        {
          provide: CommandStore,
          useValue: {
            loadCommands: vi.fn(), commands: signal([]), commandEligibility: vi.fn(() => ({ eligible: true })),
            getCommandByName: vi.fn(), resolveCommand: vi.fn(), executeCommand: vi.fn(),
          },
        },
        { provide: DraftService, useValue: { textVersion: signal(0), getDraft: vi.fn(() => ''), setDraft: vi.fn(), clearDraft: vi.fn() } },
        { provide: PromptSuggestionService, useValue: { getSuggestion: vi.fn(() => null) } },
        { provide: PerfInstrumentationService, useValue: { markComposerLatency: vi.fn(() => vi.fn()) } },
        {
          provide: ProviderStateService,
          useValue: {
            selectedProvider: signal<ProviderType>('claude'), selectedModel: signal('opus'), setProvider: vi.fn(), setModel: vi.fn(),
            getFastModeForProvider: vi.fn(() => false), getLaunchModeForProvider: vi.fn(() => 'orchestrated'),
            rememberFastModeForProvider: vi.fn(), rememberModelForProvider: vi.fn(),
          },
        },
        {
          // The new-session composer reads the full draft; the live-session one only needs the basics.
          provide: NewSessionDraftService,
          useValue: {
            revision: signal(0), activeKey: signal('__default__'), prompt: signal(''), provider: signal(null), model: signal(null),
            modelRuntimeTarget: signal(null), reasoningEffort: signal(null), nodeId: signal(null), hardened: signal(null),
            launchMode: signal(null), signalFenceOff: signal(false), yoloMode: signal(null), agentId: signal('build'),
            accountProfileId: signal(null), setAccountProfileId: vi.fn(),
            setProvider: vi.fn(), setModel: vi.fn(), setAgentId: vi.fn(), setYoloMode: vi.fn(), setHardened: vi.fn(),
            setSignalFenceOff: vi.fn(), setModelRuntimeTarget: vi.fn(), setReasoningEffort: vi.fn(), setNodeId: vi.fn(),
            setLaunchMode: vi.fn(), setPrompt: vi.fn(), clearActiveComposer: vi.fn(),
          },
        },
        { provide: SettingsStore, useValue: { defaultYoloMode: signal(false), settings: signal({ providerSignalFenceEnabled: true }) } },
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
    fixture.componentRef.setInput('instanceId', 'inst-1');
    fixture.detectChanges();
  });

  describe('Continue after an interrupted turn', () => {
    it('is offered under an empty, enabled composer for a live session', () => {
      expect(continuation()).not.toBeNull();
      expect(continuation().componentInstance.instanceId).toBe('inst-1');
    });

    it('follows the session when the composer switches to another one', () => {
      set('instanceId', 'inst-2');

      expect(continuation().componentInstance.instanceId).toBe('inst-2');
    });

    it('is hidden once something is typed, and comes back when the box is empty again', () => {
      component.message.set('Bun');
      fixture.detectChanges();
      expect(continuation()).toBeNull();

      component.message.set('');
      fixture.detectChanges();
      expect(continuation()).not.toBeNull();
    });

    it('counts a box with only spaces as empty, the same way Send does', () => {
      component.message.set('   ');
      fixture.detectChanges();

      expect(continuation()).not.toBeNull();
    });

    it('is hidden while the composer is disabled', () => {
      set('disabled', true);

      expect(continuation()).toBeNull();
    });

    it('is hidden while editing a message, even when the text has been cleared', () => {
      component.editMode.set(true);
      fixture.detectChanges();
      expect(continuation()).toBeNull();
    });

    it('is hidden while configuring a loop instead of continuing a turn', () => {
      component.showLoopPanel.set(true);
      fixture.detectChanges();
      expect(continuation()).toBeNull();
    });

    it('is hidden while a file is attached', () => {
      set('pendingFiles', [new File(['x'], 'notes.txt', { type: 'text/plain' })]);

      expect(continuation()).toBeNull();
    });

    it('is hidden while a folder is attached', () => {
      set('pendingFolders', ['/repo/docs']);

      expect(continuation()).toBeNull();
    });

    it('is never offered in the new-session composer, which has no turn to continue', () => {
      set('instanceId', 'new');

      expect(continuation()).toBeNull();
    });
  });

  describe('queued messages', () => {
    it('tell the queue why the session is waiting so it can show a ticking reason', () => {
      set('queuedMessages', [{ message: 'later' }]);
      set('waitReason', backoff);

      expect(queue().componentInstance.waitReason).toEqual(backoff);
    });

    it('pass no reason when the session is not waiting', () => {
      set('queuedMessages', [{ message: 'later' }]);

      expect(queue().componentInstance.waitReason).toBeUndefined();
    });
  });

  // The composer now shows one provider-neutral line while a session compacts (see composer-hint.ts),
  // so a queued message can never be told it is waiting on the wrong provider.
  describe('compaction wording', () => {
    beforeEach(() => {
      set('isCompacting', true);
      set('queuedCount', 1);
    });

    it.each([
      ['codex'],
      ['claude'],
      ['gemini'],
      ['copilot'],
      ['opencode'],
    ])('says the same provider-neutral line for %s while a queued message waits for compaction', (provider) => {
      set('provider', provider);

      expect(hints()).toEqual(['Compacting the conversation… your message will send afterwards']);
    });

    it('never says Codex for a session that is not Codex', () => {
      set('provider', 'claude');

      expect(hints().join(' ')).not.toContain('Codex');
    });
  });
});
