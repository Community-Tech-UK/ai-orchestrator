/**
 * Input Panel Component - Text input for sending messages to Claude
 */

import {
  Component,
  ChangeDetectionStrategy,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { CommandStore } from '../../core/state/command.store';
import type { ExtendedCommand } from '../../core/state/command.store';
import { ActionDispatchService } from '../../core/services/action-dispatch.service';
import { DraftService } from '../../core/services/draft.service';
import { KeybindingService } from '../../core/services/keybinding.service';
import { OrchestrationIpcService } from '../../core/services/ipc';
import { PromptSuggestionService } from '../../core/services/prompt-suggestion.service';
import { PerfInstrumentationService } from '../../core/services/perf-instrumentation.service';
import { PromptHistoryStore } from '../../core/state/prompt-history.store';
import {
  ProviderSelectorComponent,
  ProviderType
} from '../providers/provider-selector.component';
import { CopilotModelSelectorComponent } from '../providers/copilot-model-selector.component';
import { AgentSelectorComponent } from '../agents/agent-selector.component';
import { ProviderStateService } from '../../core/services/provider-state.service';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { SettingsStore } from '../../core/state/settings.store';
import { getPrimaryModelForProvider, normalizeModelForProvider } from '../../../../shared/types/provider.types';
import type { AgentProfile } from '../../../../shared/types/agent.types';
import type { CommandResolutionResult } from '../../../../shared/types/command.types';
import {
  PROMPT_HISTORY_STASH_KEY_PREFIX,
  createPromptHistoryEntryId,
  type PromptHistoryEntry,
} from '../../../../shared/types/prompt-history.types';
import {
  isCaretOnFirstVisualLine,
  isCaretOnLastVisualLine,
} from '../../core/services/textarea-caret-position.util';
import type {
  InstanceProvider,
  InstanceStatus,
  OutputMessage
} from '../../core/state/instance/instance.types';
import type { NlWorkflowSuggestion } from '../../../../shared/types/workflow.types';

@Component({
  selector: 'app-input-panel',
  standalone: true,
  imports: [ProviderSelectorComponent, CopilotModelSelectorComponent, AgentSelectorComponent],
  templateUrl: './input-panel.component.html',
  styleUrl: './input-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InputPanelComponent implements OnDestroy {
  protected commandStore = inject(CommandStore);
  private draftService = inject(DraftService);
  private suggestionService = inject(PromptSuggestionService);
  private perf = inject(PerfInstrumentationService);
  private providerState = inject(ProviderStateService);
  private newSessionDraft = inject(NewSessionDraftService);
  private settingsStore = inject(SettingsStore);
  private actionDispatch = inject(ActionDispatchService);
  private keybindingService = inject(KeybindingService);
  private orchestrationIpc = inject(OrchestrationIpcService);
  private promptHistoryStore = inject(PromptHistoryStore);
  private filePreviewUrls = new Map<File, string>();
  private textareaRef = viewChild<ElementRef<HTMLTextAreaElement>>('textareaRef');

  instanceId = input.required<string>();
  disabled = input<boolean>(false);
  placeholder = input<string>('Send a message...');
  pendingFiles = input<File[]>([]);
  pendingFolders = input<string[]>([]);
  queuedCount = input<number>(0);
  queuedMessages = input<{
    message: string;
    files?: File[];
    kind?: 'queue' | 'steer';
    hadAttachmentsDropped?: boolean;
  }[]>([]);
  isBusy = input<boolean>(false);
  isRespawning = input<boolean>(false);
  outputMessages = input<OutputMessage[]>([]);
  instanceStatus = input<InstanceStatus>('idle');
  provider = input<InstanceProvider>('claude');
  currentModel = input<string | undefined>(undefined);
  workingDirectory = input<string | null>(null);
  isReplayFallback = input<boolean>(false);

  // Computed preview data for pending files
  pendingFilePreviews = computed(() => {
    const files = this.pendingFiles();
    return files.map(file => ({
      file,
      isImage: file.type.startsWith('image/'),
      previewUrl: this.getOrCreatePreviewUrl(file),
      size: this.formatFileSize(file.size),
      icon: this.getFileIcon(file),
    }));
  });

  private getOrCreatePreviewUrl(file: File): string {
    if (!this.filePreviewUrls.has(file)) {
      const url = URL.createObjectURL(file);
      this.filePreviewUrls.set(file, url);
    }
    return this.filePreviewUrls.get(file)!;
  }

  sendMessage = output<string>();
  steerMessage = output<string>();
  draftStarted = output<void>();
  executeCommand = output<{ commandId: string; args: string[] }>();
  removeFile = output<File>();
  removeFolder = output<string>();
  addFiles = output<void>();
  cancelQueuedMessage = output<number>(); // Emits the index of the message to cancel
  resendEdited = output<{
    messageIndex: number;
    messageId?: string;
    text: string;
    attachments?: OutputMessage['attachments'];
    retryMode: 'transcript-only';
  }>();

  editMode = signal(false);
  private stashedDraft = signal<string | null>(null);
  private editMessageIndex = signal<number | null>(null);

  private lastUserMessage = computed(() => {
    const msgs = this.outputMessages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].type === 'user') {
        return {
          text: msgs[i].content,
          bufferIndex: i,
          messageId: msgs[i].id,
          attachments: msgs[i].attachments,
        };
      }
    }
    return null;
  });

  message = signal('');
  showCommandSuggestions = signal(false);
  selectedCommandIndex = signal(0);
  slashResolution = signal<CommandResolutionResult | null>(null);
  private recallIndex = signal<number | null>(null);
  private recalledEntryId = signal<string | null>(null);
  private recallEntries = computed(() =>
    this.promptHistoryStore.getEntriesForRecall(this.instanceId(), this.workingDirectory())
  );
  // Computed: filter commands based on input
  filteredCommands = computed(() => {
    const msg = this.message();
    if (!msg.startsWith('/')) return [];

    const query = msg.slice(1).toLowerCase().split(/\s/)[0];
    const commands = this.commandStore.commands();

    const visible = commands.filter((command) => {
      const eligibility = this.commandStore.commandEligibility(command);
      return eligibility.eligible || command.applicability?.hideWhenIneligible !== true;
    });

    if (!query) return visible.slice(0, 8); // Show first 8 commands when just "/" is typed

    return visible
      .filter(cmd =>
        cmd.name.toLowerCase().startsWith(query) ||
        (cmd.aliases ?? []).some((alias) => alias.toLowerCase().startsWith(query))
      )
      .slice(0, 8);
  });
  resolutionCommands = computed((): ExtendedCommand[] => {
    const resolution = this.slashResolution();
    if (!resolution) return [];
    if (resolution.kind === 'fuzzy') {
      return resolution.suggestions as ExtendedCommand[];
    }
    if (resolution.kind === 'ambiguous') {
      return resolution.candidates as ExtendedCommand[];
    }
    return [];
  });
  visibleCommandSuggestions = computed(() => {
    const resolution = this.resolutionCommands();
    return resolution.length > 0 ? resolution : this.filteredCommands();
  });

  slashResolutionLabel = computed(() => {
    const resolution = this.slashResolution();
    if (!resolution) return null;
    if (resolution.kind === 'fuzzy') {
      return `Did you mean one of these commands for /${resolution.query}?`;
    }
    if (resolution.kind === 'ambiguous') {
      return `/${resolution.query} matches more than one command`;
    }
    if (resolution.kind === 'none') {
      return `No command found for /${resolution.query}`;
    }
    return null;
  });

  isDraftComposer = computed(() => this.instanceId() === 'new');

  /** True when the instance is starting up or waking from hibernation — input should be blocked */
  readonly isInitializing = computed(() => {
    const status = this.instanceStatus();
    return status === 'initializing' || status === 'waking';
  });
  readonly isSteeringTarget = computed(() => {
    const status = this.instanceStatus();
    return status === 'busy'
      || status === 'processing'
      || status === 'thinking_deeply'
      || status === 'waiting_for_permission'
      || status === 'respawning'
      || status === 'interrupting'
      || status === 'cancelling'
      || status === 'interrupt-escalating';
  });
  selectedProvider = computed(() =>
    this.isDraftComposer()
      ? (this.newSessionDraft.provider() ?? this.providerState.selectedProvider())
      : this.providerState.selectedProvider()
  );
  selectedModel = computed(() =>
    this.isDraftComposer()
      ? (
          (() => {
            const provider = this.selectedProvider();
            const draftProvider = this.newSessionDraft.provider();
            const fallbackModel =
              draftProvider && draftProvider !== 'auto'
                ? (getPrimaryModelForProvider(provider) ?? this.providerState.selectedModel())
                : this.providerState.selectedModel();

            return normalizeModelForProvider(
              provider,
              this.newSessionDraft.model(),
              fallbackModel,
            ) ?? fallbackModel;
          })()
        )
      : this.providerState.selectedModel()
  );

  readonly selectedAgentId = computed(() => this.newSessionDraft.agentId());

  onAgentSelected(agent: AgentProfile): void {
    this.newSessionDraft.setAgentId(agent.id);
  }

  /** Effective YOLO mode: draft override ?? settings default */
  effectiveYoloMode = computed(() => {
    const draftValue = this.newSessionDraft.yoloMode();
    return draftValue ?? this.settingsStore.defaultYoloMode();
  });

  // Ghost text suggestion state
  ghostSuggestion = signal<string | null>(null);
  nlWorkflowSuggestion = signal<NlWorkflowSuggestion | null>(null);
  nlWorkflowSuggestionError = signal<string | null>(null);
  private isFocused = signal(false);
  private nlWorkflowSuggestionTimer: ReturnType<typeof setTimeout> | null = null;

  // Computed: whether to show ghost text
  showGhostText = computed(() => {
    const suggestion = this.ghostSuggestion();
    if (!suggestion) return false;
    if (!this.isFocused()) return false;
    if (this.showCommandSuggestions()) return false;
    if (this.isBusy()) return false;
    if (this.isRespawning()) return false;
    if (this.disabled()) return false;

    const msg = this.message();
    // Show if empty, or if current text is a case-insensitive prefix of suggestion
    return !msg || suggestion.toLowerCase().startsWith(msg.toLowerCase());
  });

  // Computed: the remaining ghost text after what the user has typed
  ghostRemainder = computed(() => {
    const suggestion = this.ghostSuggestion();
    if (!suggestion) return '';
    const msg = this.message();
    if (!msg) return suggestion;
    return suggestion.slice(msg.length);
  });

  // ViewChild for textarea
  private textareaEl = viewChild<ElementRef<HTMLTextAreaElement>>('textareaRef');

  constructor() {
    // Load commands on init
    this.commandStore.loadCommands();

    // Reset edit-mode state when switching between instances. The composer is
    // mounted once at the dashboard level and reused for every session, so
    // component-local signals (editMode, stashedDraft, editMessageIndex)
    // persist when instanceId changes unless we explicitly clear them.
    // Without this, entering edit mode on session A leaves the "Editing last
    // message" banner visible after switching to session B.
    effect(() => {
      this.instanceId(); // track changes to the active instance
      untracked(() => {
        if (this.editMode()) {
          this.editMode.set(false);
          this.stashedDraft.set(null);
          this.editMessageIndex.set(null);
        }
        this.resetPromptRecall({ restoreStash: false });
      });
    });

    effect(() => {
      const requested = this.promptHistoryStore.requestedRecallEntry();
      if (!requested) {
        return;
      }

      untracked(() => {
        this.applyRecalledEntry(requested);
        this.promptHistoryStore.clearRequestedRecallEntry(requested);
      });
    });

    // Keep the composer input synchronized with the correct backing draft store.
    effect(() => {
      if (this.editMode()) return;

      if (this.isDraftComposer()) {
        this.newSessionDraft.revision();
        const savedDraft = this.newSessionDraft.prompt();
        if (untracked(() => this.message()) !== savedDraft) {
          this.message.set(savedDraft);
        }
        return;
      }

      const currentId = this.instanceId();
      this.draftService.textVersion();
      const savedDraft = this.draftService.getDraft(currentId);
      if (untracked(() => this.message()) !== savedDraft) {
        this.message.set(savedDraft);
      }
    });

    // Clean up preview URLs when files change
    effect(() => {
      const files = this.pendingFiles();
      const currentFiles = new Set(files);

      // Revoke URLs for removed files
      for (const [file, url] of this.filePreviewUrls.entries()) {
        if (!currentFiles.has(file)) {
          URL.revokeObjectURL(url);
          this.filePreviewUrls.delete(file);
        }
      }
    });

    // Generate ghost text suggestion when conversation state changes
    effect(() => {
      // Track these signals to re-run when they change
      this.outputMessages();
      this.isReplayFallback();
      const status = this.instanceStatus();
      const currentText = this.message();

      // Don't generate while busy, starting up, or when user has typed something
      if (
        status === 'busy'
        || status === 'initializing'
        || status === 'waking'
        || status === 'respawning'
        || status === 'interrupting'
        || status === 'cancelling'
        || status === 'interrupt-escalating'
        || currentText
      ) {
        this.ghostSuggestion.set(null);
        return;
      }

      this.generateSuggestion();
    });
  }

  ngOnDestroy(): void {
    if (this.nlWorkflowSuggestionTimer) {
      clearTimeout(this.nlWorkflowSuggestionTimer);
      this.nlWorkflowSuggestionTimer = null;
    }
    // Clean up all preview URLs
    for (const url of this.filePreviewUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this.filePreviewUrls.clear();
  }

  canSend(): boolean {
    return this.message().trim().length > 0 || this.pendingFilePreviews().length > 0 || this.pendingFolders().length > 0;
  }

  getFolderDisplayName(folderPath: string): string {
    // Extract just the folder name from the full path
    const parts = folderPath.split('/').filter(Boolean);
    return parts[parts.length - 1] || folderPath;
  }

  onInput(event: Event): void {
    const stopComposer = this.perf.markComposerLatency();
    const textarea = event.target as HTMLTextAreaElement;
    const value = textarea.value;
    this.message.set(value);
    stopComposer(); // Measure composer latency

    if (value.trim().length > 0) {
      this.draftStarted.emit();
    }

    if (this.recallIndex() !== null && value !== this.currentRecalledText()) {
      this.resetPromptRecall({ restoreStash: false });
    }

    this.persistComposerText(value);

    // Show command suggestions when typing "/"
    if (value.startsWith('/') && !value.includes('\n')) {
      this.showCommandSuggestions.set(true);
      this.selectedCommandIndex.set(0);
      void this.refreshSlashResolution(value);
    } else {
      this.showCommandSuggestions.set(false);
      this.slashResolution.set(null);
    }

    // Update ghost text suggestion
    this.updateGhostSuggestion(value);
    this.scheduleNlWorkflowSuggestion(value);

    // Auto-resize textarea - debounced via requestAnimationFrame to avoid blocking input
    this.scheduleTextareaResize(textarea);
  }

  private scheduleNlWorkflowSuggestion(value: string): void {
    if (this.nlWorkflowSuggestionTimer) {
      clearTimeout(this.nlWorkflowSuggestionTimer);
      this.nlWorkflowSuggestionTimer = null;
    }

    const text = value.trim();
    if (
      text.length < 12 ||
      text.startsWith('/') ||
      this.showCommandSuggestions() ||
      this.disabled() ||
      this.isBusy() ||
      this.isRespawning() ||
      this.isInitializing()
    ) {
      this.nlWorkflowSuggestion.set(null);
      this.nlWorkflowSuggestionError.set(null);
      return;
    }

    this.nlWorkflowSuggestionTimer = setTimeout(() => {
      void this.refreshNlWorkflowSuggestion(text);
    }, 450);
  }

  private async refreshNlWorkflowSuggestion(text: string): Promise<void> {
    if (this.message().trim() !== text) {
      return;
    }

    const response = await this.orchestrationIpc.workflowNlSuggest({
      promptText: text,
      provider: this.provider(),
      workingDirectory: this.workingDirectory() ?? undefined,
    });

    if (this.message().trim() !== text) {
      return;
    }

    if (response.success && response.data) {
      // The classifier always returns a suggestion for text ≥ 12 chars,
      // falling back to a `small`/`slash-command` `/explain` default when no
      // workflow signals are present. Per the spec, the slash-command surface
      // was meant to surface in the `/` dropdown, not as an interrupting
      // banner — so suppress it here and only show banners for medium
      // (template-confirm) and large (preflight-modal) suggestions.
      if (response.data.surface === 'slash-command') {
        this.nlWorkflowSuggestion.set(null);
        this.nlWorkflowSuggestionError.set(null);
        return;
      }
      this.nlWorkflowSuggestion.set(response.data);
      this.nlWorkflowSuggestionError.set(null);
    }
  }

  async acceptNlWorkflowSuggestion(): Promise<void> {
    const suggestion = this.nlWorkflowSuggestion();
    if (!suggestion?.suggestedRef) {
      return;
    }

    console.info('nl-classifier.acted-on', { classification: suggestion, action: 'accepted' });

    if (suggestion.suggestedRef.startsWith('/')) {
      const current = this.message().trim();
      const next = `${suggestion.suggestedRef} ${current}`.trim();
      this.message.set(next);
      this.persistComposerText(next);
      this.nlWorkflowSuggestion.set(null);
      return;
    }

    const instanceId = this.instanceId();
    if (instanceId === 'new') {
      this.nlWorkflowSuggestionError.set('Start a session before launching a workflow.');
      return;
    }

    const transition = await this.orchestrationIpc.workflowCanTransition({
      instanceId,
      templateId: suggestion.suggestedRef,
      source: 'nl-suggestion',
    });
    const policy = transition.data?.policy;
    if (!transition.success || policy?.kind === 'deny') {
      this.nlWorkflowSuggestionError.set(
        policy?.kind === 'deny'
          ? policy.reason
          : transition.error?.message || 'Workflow cannot start.',
      );
      return;
    }

    const started = await this.orchestrationIpc.workflowStart({
      instanceId,
      templateId: suggestion.suggestedRef,
      source: 'nl-suggestion',
    });
    if (started.success) {
      this.nlWorkflowSuggestion.set(null);
      this.nlWorkflowSuggestionError.set(null);
      return;
    }

    this.nlWorkflowSuggestionError.set(started.error?.message || 'Workflow start failed.');
  }

  dismissNlWorkflowSuggestion(): void {
    const suggestion = this.nlWorkflowSuggestion();
    if (suggestion) {
      console.info('nl-classifier.acted-on', { classification: suggestion, action: 'dismissed' });
    }
    this.nlWorkflowSuggestion.set(null);
    this.nlWorkflowSuggestionError.set(null);
  }

  private resizeScheduled = false;
  private scheduleTextareaResize(textarea: HTMLTextAreaElement): void {
    if (this.resizeScheduled) return;
    this.resizeScheduled = true;

    requestAnimationFrame(() => {
      this.resizeScheduled = false;
      const maxHeight = Math.min(window.innerHeight * 0.38, 520);
      const newHeight = Math.min(textarea.scrollHeight, maxHeight);
      if (textarea.style.height !== `${newHeight}px`) {
        textarea.style.height = 'auto';
        textarea.style.height = `${newHeight}px`;
      }
    });
  }

  onKeyDown(event: KeyboardEvent): void {
    // Handle command suggestions navigation
    if (this.showCommandSuggestions() && this.visibleCommandSuggestions().length > 0) {
      const commands = this.visibleCommandSuggestions();

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          this.selectedCommandIndex.update(i =>
            i < commands.length - 1 ? i + 1 : 0
          );
          return;

        case 'ArrowUp':
          event.preventDefault();
          this.selectedCommandIndex.update(i =>
            i > 0 ? i - 1 : commands.length - 1
          );
          return;

        case 'Tab':
        case 'Enter': {
          event.preventDefault();
          const selected = commands[this.selectedCommandIndex()];
          if (selected) {
            this.onSelectCommand(selected);
          }
          return;
        }

        case 'Escape':
          event.preventDefault();
          this.showCommandSuggestions.set(false);
          return;
      }
    }

    if (event.key.toLowerCase() === 'r' && event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      void this.actionDispatch.dispatch('open-prompt-history-search');
      return;
    }

    if (event.key === 'ArrowUp' && !this.editMode()) {
      const textarea = event.target as HTMLTextAreaElement;
      if (isCaretOnFirstVisualLine(textarea) && this.recallPrompt(-1)) {
        event.preventDefault();
        return;
      }
    }

    if (event.key === 'ArrowDown' && !this.editMode()) {
      const textarea = event.target as HTMLTextAreaElement;
      if (isCaretOnLastVisualLine(textarea) && this.recallPrompt(1)) {
        event.preventDefault();
        return;
      }
    }

    if (event.key === 'Escape' && this.recallIndex() !== null && !this.editMode()) {
      event.preventDefault();
      this.resetPromptRecall({ restoreStash: true });
      return;
    }

    // Ghost text acceptance
    if (this.showGhostText()) {
      if (event.key === 'Tab') {
        event.preventDefault();
        this.acceptGhostSuggestion();
        return;
      }

      if (event.key === 'ArrowRight') {
        const textarea = event.target as HTMLTextAreaElement;
        if (textarea.selectionStart === this.message().length) {
          event.preventDefault();
          this.acceptGhostSuggestion();
          return;
        }
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        this.dismissGhostSuggestion();
        return;
      }
    }

    // Edit mode: Escape to cancel
    if (event.key === 'Escape' && this.editMode()) {
      event.preventDefault();
      this.cancelEditMode();
      return;
    }

    // UP arrow at cursor position 0 to enter edit mode
    // enterEditMode() auto-interrupts if the instance is busy
    if (event.key === 'ArrowUp' && !this.editMode()) {
      const textarea = event.target as HTMLTextAreaElement;
      if (textarea.selectionStart === 0 && textarea.selectionEnd === 0 && this.lastUserMessage()) {
        event.preventDefault();
        this.enterEditMode();
        return;
      }
    }

    // Edit mode: Enter to resend edited message
    if (event.key === 'Enter' && !event.shiftKey && this.editMode()) {
      event.preventDefault();
      this.sendEditedMessage();
      return;
    }

    // Normal enter to send
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.onSend();
    }
  }

  onSelectCommand(command: ExtendedCommand): void {
    const eligibility = this.commandStore.commandEligibility(command);
    if (!eligibility.eligible) {
      return;
    }

    // Get any args after the command name in the current message
    const msg = this.message();
    const parts = msg.slice(1).split(/\s+/);
    const args = parts.slice(1).filter(Boolean);

    if (command.execution?.type === 'ui') {
      this.recordPromptHistory(msg.trim(), true);
      void this.actionDispatch.dispatch(command.execution.actionId);
      this.executeCommand.emit({ commandId: command.id, args });
      this.message.set('');
      this.showCommandSuggestions.set(false);
      this.slashResolution.set(null);
      this.clearComposerDraft();
      return;
    }

    // Execute the command
    this.recordPromptHistory(msg.trim(), true);
    this.commandStore.executeCommand(command.id, this.instanceId(), args);
    this.executeCommand.emit({ commandId: command.id, args });

    // Clear input and draft
    this.message.set('');
    this.showCommandSuggestions.set(false);
    this.slashResolution.set(null);
    if (!this.isDraftComposer()) {
      this.clearComposerDraft();
    }

    // Reset textarea height
    const textarea = this.textareaRef()?.nativeElement;
    if (textarea) {
      textarea.style.height = 'auto';
    }
  }

  async onSend(): Promise<void> {
    if (!this.canSend() || this.disabled() || this.isInitializing()) return;

    const text = this.message().trim();

    // Check if it's a command
    if (text.startsWith('/')) {
      const parts = text.slice(1).split(/\s+/);
      const cmdName = parts[0];

      const command = this.commandStore.getCommandByName(cmdName);
      if (command) {
        this.onSelectCommand(command as ExtendedCommand);
        return;
      }

      const resolved = await this.commandStore.resolveCommand(text);
      if (resolved?.kind === 'exact' || resolved?.kind === 'alias') {
        this.onSelectCommand(resolved.command as ExtendedCommand);
        return;
      }
      if (resolved?.kind === 'fuzzy' || resolved?.kind === 'ambiguous' || resolved?.kind === 'none') {
        this.slashResolution.set(resolved);
        this.showCommandSuggestions.set(true);
        return;
      }
    }

    if (this.isSteeringTarget()) {
      this.recordPromptHistory(text, false);
      this.steerMessage.emit(text);
    } else {
      this.recordPromptHistory(text, false);
      this.sendMessage.emit(text);
    }
    this.message.set('');
    this.showCommandSuggestions.set(false);
    this.slashResolution.set(null);
    this.clearComposerDraft();

    // Reset textarea height
    const textarea = this.textareaRef()?.nativeElement;
    if (textarea) {
      textarea.style.height = 'auto';
    }
  }

  // ============================================
  // Edit Mode Methods
  // ============================================

  /**
   * Enter edit mode, loading the last user message into the input.
   * Public so instance-detail can trigger it from the output stream's edit button.
   */
  enterEditMode(): void {
    const last = this.lastUserMessage();
    if (!last || this.editMode()) return;

    // Don't interrupt the CLI — sending the edit forks to a new instance and
    // force-terminates this one, so any --resume against the old session is
    // both wasteful and prone to spurious "resume failed" errors.
    this.stashedDraft.set(this.message());
    this.message.set(last.text);
    this.editMessageIndex.set(last.bufferIndex);
    this.editMode.set(true);

    // Place cursor at end of loaded text and focus
    requestAnimationFrame(() => {
      const textarea = this.textareaRef()?.nativeElement;
      if (textarea) {
        textarea.value = last.text;
        textarea.selectionStart = last.text.length;
        textarea.selectionEnd = last.text.length;
        textarea.focus();
        this.scheduleTextareaResize(textarea);
      }
    });
  }

  private cancelEditMode(): void {
    this.message.set(this.stashedDraft() ?? '');
    this.editMode.set(false);
    this.stashedDraft.set(null);
    this.editMessageIndex.set(null);

    // Restore textarea content
    requestAnimationFrame(() => {
      const textarea = this.textareaRef()?.nativeElement;
      if (textarea) {
        textarea.value = this.message();
        this.scheduleTextareaResize(textarea);
      }
    });
  }

  private sendEditedMessage(): void {
    // Allow resend even while busy/respawning — onResendEdited forks to a new
    // instance and force-terminates this one, so the old CLI's state doesn't
    // matter. `disabled` still blocks during initialization.
    if (!this.canSend() || this.disabled()) return;

    const idx = this.editMessageIndex();
    if (idx === null) return;

    const confirmed = window.confirm(
      'This retry will fork the transcript only. Filesystem checkpoint restore is not available for this edit. Continue?',
    );
    if (!confirmed) return;

    this.resendEdited.emit({
      messageIndex: idx,
      messageId: this.lastUserMessage()?.messageId,
      text: this.message(),
      attachments: this.lastUserMessage()?.attachments,
      retryMode: 'transcript-only',
    });

    this.message.set('');
    this.editMode.set(false);
    this.stashedDraft.set(null);
    this.editMessageIndex.set(null);
    this.clearComposerDraft();

    const textarea = this.textareaRef()?.nativeElement;
    if (textarea) {
      textarea.style.height = 'auto';
    }
  }

  // ============================================
  // Ghost Text Suggestion Methods
  // ============================================

  onFocus(): void {
    this.isFocused.set(true);
    this.keybindingService.setContext('input');
  }

  onBlur(): void {
    this.isFocused.set(false);
    this.keybindingService.setContext('global');
  }

  private generateSuggestion(): void {
    const suggestion = this.suggestionService.getSuggestion({
      messages: this.outputMessages(),
      status: this.instanceStatus(),
      hasFiles: this.pendingFiles().length > 0,
      currentText: this.message(),
      isReplayFallback: this.isReplayFallback(),
    });
    this.ghostSuggestion.set(suggestion);
  }

  private updateGhostSuggestion(currentText: string): void {
    // Don't show ghost text when command suggestions are active
    if (this.showCommandSuggestions()) {
      this.ghostSuggestion.set(null);
      return;
    }

    // If user typed text that still matches current suggestion prefix, keep it
    const current = this.ghostSuggestion();
    if (current && currentText && current.toLowerCase().startsWith(currentText.toLowerCase())) {
      return; // Still a prefix match, keep the ghost
    }

    // If field is now empty, regenerate suggestion
    if (!currentText) {
      this.generateSuggestion();
    } else {
      // User typed something that doesn't match — dismiss
      this.ghostSuggestion.set(null);
    }
  }

  private async refreshSlashResolution(value: string): Promise<void> {
    const query = value.slice(1).trim().split(/\s+/)[0] ?? '';
    if (query.length < 2) {
      this.slashResolution.set(null);
      return;
    }

    const resolved = await this.commandStore.resolveCommand(value);
    if (this.message() !== value) return;

    if (resolved?.kind === 'fuzzy' || resolved?.kind === 'ambiguous') {
      this.slashResolution.set(resolved);
      return;
    }
    this.slashResolution.set(null);
  }

  private acceptGhostSuggestion(): void {
    const suggestion = this.ghostSuggestion();
    if (!suggestion) return;

    this.message.set(suggestion);
    this.ghostSuggestion.set(null);

    this.persistComposerText(suggestion);

    // Update textarea value and resize
    const el = this.textareaEl();
    if (el) {
      el.nativeElement.value = suggestion;
      this.scheduleTextareaResize(el.nativeElement);
    }
  }

  private dismissGhostSuggestion(): void {
    this.ghostSuggestion.set(null);
  }

  getFileIcon(file: File): string {
    if (file.type.startsWith('image/')) return '🖼️';
    if (file.type.includes('pdf')) return '📄';
    if (file.type.includes('text')) return '📝';
    if (file.type.includes('json') || file.type.includes('javascript')) return '📋';
    return '📎';
  }

  formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  onRemoveFile(file: File): void {
    // Revoke the preview URL
    const url = this.filePreviewUrls.get(file);
    if (url) {
      URL.revokeObjectURL(url);
      this.filePreviewUrls.delete(file);
    }
    this.removeFile.emit(file);
  }

  onAddFiles(): void {
    this.addFiles.emit();
  }

  onRemoveFolder(folder: string): void {
    this.removeFolder.emit(folder);
  }

  truncateMessage(message: string): string {
    const firstLine = message.split('\n')[0];
    if (firstLine.length > 50) {
      return firstLine.slice(0, 50) + '...';
    }
    return firstLine + (message.includes('\n') ? '...' : '');
  }

  onCancelQueuedMessage(index: number): void {
    this.cancelQueuedMessage.emit(index);
  }

  onToggleYoloMode(): void {
    this.newSessionDraft.setYoloMode(!this.effectiveYoloMode());
  }

  onProviderSelected(provider: ProviderType): void {
    if (this.isDraftComposer()) {
      this.newSessionDraft.setProvider(provider);
      return;
    }
    this.providerState.setProvider(provider);
  }

  onModelSelected(model: string): void {
    if (this.isDraftComposer()) {
      this.newSessionDraft.setProvider(this.selectedProvider());
      this.newSessionDraft.setModel(model);
      return;
    }
    this.providerState.setModel(model);
  }

  private persistComposerText(value: string): void {
    if (this.isDraftComposer()) {
      this.newSessionDraft.setPrompt(value);
      return;
    }

    this.draftService.setDraft(this.instanceId(), value);
  }

  private clearComposerDraft(): void {
    if (this.isDraftComposer()) {
      this.newSessionDraft.clearActiveComposer();
      return;
    }

    this.draftService.clearDraft(this.instanceId());
  }

  private recallPrompt(direction: -1 | 1): boolean {
    const entries = this.recallEntries();
    if (entries.length === 0) {
      return false;
    }

    const currentIndex = this.recallIndex();
    if (direction === -1) {
      const nextIndex = currentIndex === null
        ? 0
        : Math.min(currentIndex + 1, entries.length - 1);
      if (currentIndex === nextIndex && this.recalledEntryId() === entries[nextIndex]?.id) {
        return false;
      }
      this.applyRecalledEntry(entries[nextIndex], nextIndex);
      return true;
    }

    if (currentIndex === null) {
      return false;
    }
    if (currentIndex === 0) {
      this.resetPromptRecall({ restoreStash: true });
      return true;
    }

    this.applyRecalledEntry(entries[currentIndex - 1], currentIndex - 1);
    return true;
  }

  private applyRecalledEntry(entry: PromptHistoryEntry, index?: number): void {
    if (this.recallIndex() === null) {
      this.draftService.setDraft(this.stashKey(), this.message());
    }

    this.recallIndex.set(index ?? Math.max(0, this.recallEntries().findIndex((candidate) => candidate.id === entry.id)));
    this.recalledEntryId.set(entry.id);
    this.message.set(entry.text);
    this.persistComposerText(entry.text);
    this.syncTextareaValue(entry.text);
  }

  private resetPromptRecall(options: { restoreStash: boolean }): void {
    const stashKey = this.stashKey();
    const stashed = this.draftService.getDraft(stashKey);
    this.recallIndex.set(null);
    this.recalledEntryId.set(null);
    this.draftService.clearDraft(stashKey);

    if (options.restoreStash) {
      this.message.set(stashed);
      this.persistComposerText(stashed);
      this.syncTextareaValue(stashed);
    }
  }

  private currentRecalledText(): string | null {
    const entryId = this.recalledEntryId();
    if (!entryId) {
      return null;
    }
    return this.recallEntries().find((entry) => entry.id === entryId)?.text ?? null;
  }

  private stashKey(): string {
    return `${PROMPT_HISTORY_STASH_KEY_PREFIX}${this.instanceId()}`;
  }

  private syncTextareaValue(value: string): void {
    requestAnimationFrame(() => {
      const textarea = this.textareaRef()?.nativeElement;
      if (!textarea) {
        return;
      }
      textarea.value = value;
      textarea.selectionStart = value.length;
      textarea.selectionEnd = value.length;
      textarea.focus();
      this.scheduleTextareaResize(textarea);
    });
  }

  private recordPromptHistory(text: string, wasSlashCommand: boolean): void {
    if (!text.trim() || this.isDraftComposer()) {
      return;
    }

    this.promptHistoryStore.record({
      instanceId: this.instanceId(),
      id: createPromptHistoryEntryId(),
      text,
      createdAt: Date.now(),
      projectPath: this.workingDirectory() ?? undefined,
      provider: this.provider(),
      model: this.currentModel(),
      wasSlashCommand,
    });
    this.resetPromptRecall({ restoreStash: false });
  }
}
