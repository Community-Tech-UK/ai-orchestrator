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
import { DraftService } from '../../core/services/draft.service';
import { PromptSuggestionService } from '../../core/services/prompt-suggestion.service';
import { PerfInstrumentationService } from '../../core/services/perf-instrumentation.service';
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
import type { CommandTemplate } from '../../../../shared/types/command.types';
import type {
  InstanceProvider,
  InstanceStatus,
  OutputMessage
} from '../../core/state/instance/instance.types';

@Component({
  selector: 'app-input-panel',
  standalone: true,
  imports: [ProviderSelectorComponent, CopilotModelSelectorComponent, AgentSelectorComponent],
  templateUrl: './input-panel.component.html',
  styleUrl: './input-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InputPanelComponent implements OnDestroy {
  private commandStore = inject(CommandStore);
  private draftService = inject(DraftService);
  private suggestionService = inject(PromptSuggestionService);
  private perf = inject(PerfInstrumentationService);
  private providerState = inject(ProviderStateService);
  private newSessionDraft = inject(NewSessionDraftService);
  private settingsStore = inject(SettingsStore);
  private filePreviewUrls = new Map<File, string>();
  private textareaRef = viewChild<ElementRef<HTMLTextAreaElement>>('textareaRef');

  instanceId = input.required<string>();
  disabled = input<boolean>(false);
  placeholder = input<string>('Send a message...');
  pendingFiles = input<File[]>([]);
  pendingFolders = input<string[]>([]);
  queuedCount = input<number>(0);
  queuedMessages = input<{ message: string; files?: File[] }[]>([]);
  isBusy = input<boolean>(false);
  isRespawning = input<boolean>(false);
  outputMessages = input<OutputMessage[]>([]);
  instanceStatus = input<InstanceStatus>('idle');
  provider = input<InstanceProvider>('claude');
  currentModel = input<string | undefined>(undefined);
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
  // Computed: filter commands based on input
  filteredCommands = computed(() => {
    const msg = this.message();
    if (!msg.startsWith('/')) return [];

    const query = msg.slice(1).toLowerCase().split(/\s/)[0];
    const commands = this.commandStore.commands();

    if (!query) return commands.slice(0, 8); // Show first 8 commands when just "/" is typed

    return commands
      .filter(cmd => cmd.name.toLowerCase().startsWith(query))
      .slice(0, 8);
  });

  isDraftComposer = computed(() => this.instanceId() === 'new');

  /** True when the instance is starting up or waking from hibernation — input should be blocked */
  readonly isInitializing = computed(() => {
    const status = this.instanceStatus();
    return status === 'initializing' || status === 'waking';
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
  private isFocused = signal(false);

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

    this.persistComposerText(value);

    // Show command suggestions when typing "/"
    if (value.startsWith('/') && !value.includes('\n')) {
      this.showCommandSuggestions.set(true);
      this.selectedCommandIndex.set(0);
    } else {
      this.showCommandSuggestions.set(false);
    }

    // Update ghost text suggestion
    this.updateGhostSuggestion(value);

    // Auto-resize textarea - debounced via requestAnimationFrame to avoid blocking input
    this.scheduleTextareaResize(textarea);
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
    if (this.showCommandSuggestions() && this.filteredCommands().length > 0) {
      const commands = this.filteredCommands();

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

  onSelectCommand(command: CommandTemplate): void {
    // Get any args after the command name in the current message
    const msg = this.message();
    const parts = msg.slice(1).split(/\s+/);
    const args = parts.slice(1).filter(Boolean);

    // Execute the command
    this.commandStore.executeCommand(command.id, this.instanceId(), args);
    this.executeCommand.emit({ commandId: command.id, args });

    // Clear input and draft
    this.message.set('');
    this.showCommandSuggestions.set(false);
    if (!this.isDraftComposer()) {
      this.clearComposerDraft();
    }

    // Reset textarea height
    const textarea = this.textareaRef()?.nativeElement;
    if (textarea) {
      textarea.style.height = 'auto';
    }
  }

  onSend(): void {
    if (!this.canSend() || this.disabled()) return;

    const text = this.message().trim();

    // Check if it's a command
    if (text.startsWith('/')) {
      const parts = text.slice(1).split(/\s+/);
      const cmdName = parts[0];

      const command = this.commandStore.getCommandByName(cmdName);
      if (command) {
        this.onSelectCommand(command);
        return;
      }
      // If no matching command, send as regular message
    }

    this.sendMessage.emit(text);
    this.message.set('');
    this.showCommandSuggestions.set(false);
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
  }

  onBlur(): void {
    this.isFocused.set(false);
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
}
