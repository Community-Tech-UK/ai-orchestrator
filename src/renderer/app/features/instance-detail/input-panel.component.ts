/**
 * Input Panel Component - Text input for sending messages to Claude
 */

import {
  Component,
  input,
  output,
  signal,
  computed,
  inject,
  effect,
  OnDestroy,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommandStore } from '../../core/state/command.store';
import { DraftService } from '../../core/services/draft.service';
import type { CommandTemplate } from '../../../../shared/types/command.types';

@Component({
  selector: 'app-input-panel',
  standalone: true,
  template: `
    <div class="input-panel">
      <!-- Pending files and folders preview -->
      @if (pendingFilePreviews().length > 0 || pendingFolders().length > 0) {
        <div class="pending-files">
          <!-- Folder chips -->
          @for (folder of pendingFolders(); track folder) {
            <div class="file-chip folder-chip">
              <span class="file-icon">📁</span>
              <span class="file-name" [title]="folder">{{ getFolderDisplayName(folder) }}</span>
              <button
                class="file-remove"
                (click)="onRemoveFolder(folder)"
                title="Remove folder reference"
              >
                ×
              </button>
            </div>
          }
          <!-- File previews -->
          @for (preview of pendingFilePreviews(); track preview.file.name) {
            @if (preview.isImage) {
              <div class="file-preview-card">
                <div class="preview-thumbnail" [style.background-image]="'url(' + preview.previewUrl + ')'">
                </div>
                <div class="preview-info">
                  <span class="file-name">{{ preview.file.name }}</span>
                  <span class="file-size">{{ preview.size }}</span>
                </div>
                <button
                  class="file-remove"
                  (click)="onRemoveFile(preview.file)"
                  title="Remove file"
                >
                  ×
                </button>
              </div>
            } @else {
              <div class="file-chip">
                <span class="file-icon">{{ preview.icon }}</span>
                <span class="file-name">{{ preview.file.name }}</span>
                <button
                  class="file-remove"
                  (click)="onRemoveFile(preview.file)"
                  title="Remove file"
                >
                  ×
                </button>
              </div>
            }
          }
        </div>
      }

      <!-- Command suggestions dropdown -->
      @if (showCommandSuggestions() && filteredCommands().length > 0) {
        <div class="command-suggestions">
          @for (cmd of filteredCommands(); track cmd.id; let i = $index) {
            <button
              class="suggestion-item"
              [class.selected]="i === selectedCommandIndex()"
              (click)="onSelectCommand(cmd)"
              (mouseenter)="selectedCommandIndex.set(i)"
            >
              <span class="cmd-name">/{{ cmd.name }}</span>
              <span class="cmd-desc">{{ cmd.description }}</span>
            </button>
          }
        </div>
      }

      <!-- Input area -->
      <div class="input-row">
        <button
          class="btn-attach"
          [disabled]="disabled()"
          (click)="onAddFiles()"
          title="Add files"
        >
          <span class="attach-icon">+</span>
        </button>

        <textarea
          class="message-input"
          [placeholder]="placeholder()"
          [disabled]="disabled()"
          [value]="message()"
          (input)="onInput($event)"
          (keydown)="onKeyDown($event)"
          rows="1"
          #textareaRef
        ></textarea>

        <button
          class="btn-send"
          [disabled]="disabled() || !canSend()"
          (click)="onSend()"
          title="Send message (Enter)"
        >
          <span class="send-icon">↑</span>
        </button>
      </div>

      <div class="input-hints">
        <span class="hint">Press Enter to send, Shift+Enter for new line</span>
        @if (isBusy()) {
          <span class="hint hint-interrupt">Press Esc to interrupt</span>
        } @else {
          <span class="hint">Type / for commands, Cmd+K for palette</span>
        }
      </div>

      @if (queuedCount() > 0) {
        <div class="queue-indicator">
          <span class="queue-badge">{{ queuedCount() }}</span>
          <span class="queue-text">message{{ queuedCount() > 1 ? 's' : '' }} queued</span>
        </div>
      }
    </div>
  `,
  styles: [`
    /* Input Panel - Refined message composer */
    .input-panel {
      position: relative;
      background: var(--bg-secondary);
      border-radius: var(--radius-lg);
      padding: var(--spacing-md);
      border: 1px solid var(--border-subtle);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
    }

    /* Pending Files - Attachment preview area */
    .pending-files {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-sm);
      margin-bottom: var(--spacing-sm);
      padding-bottom: var(--spacing-sm);
      border-bottom: 1px solid var(--border-subtle);
      animation: fadeIn 0.2s ease-out;
    }

    .file-chip {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      padding: var(--spacing-xs) var(--spacing-sm);
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      font-family: var(--font-mono);
      font-size: 11px;
      letter-spacing: 0.02em;
      color: var(--text-secondary);
      transition: all var(--transition-fast);
    }

    .file-chip:hover {
      border-color: var(--border-color);
    }

    .folder-chip {
      background: rgba(var(--primary-rgb), 0.1);
      border-color: rgba(var(--primary-rgb), 0.3);
      color: var(--primary-color);
    }

    .folder-chip:hover {
      border-color: var(--primary-color);
      background: rgba(var(--primary-rgb), 0.15);
    }

    .folder-chip .file-icon {
      font-size: 16px;
    }

    .file-preview-card {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: 8px 10px;
      background: var(--bg-tertiary);
      border-radius: var(--radius-md);
      border: 1px solid var(--border-subtle);
      transition: all var(--transition-fast);
    }

    .file-preview-card:hover {
      border-color: var(--border-color);
    }

    .preview-thumbnail {
      width: 52px;
      height: 52px;
      border-radius: var(--radius-md);
      overflow: hidden;
      flex-shrink: 0;
      background-color: var(--bg-secondary);
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    }

    .preview-info {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
    }

    .preview-info .file-name {
      font-family: var(--font-display);
      font-size: 12px;
      font-weight: 600;
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-primary);
    }

    .file-size {
      font-family: var(--font-mono);
      font-size: 10px;
      letter-spacing: 0.03em;
      color: var(--text-muted);
    }

    .file-icon {
      font-size: 14px;
    }

    .file-name {
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .file-remove {
      width: 22px;
      height: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      border: none;
      font-size: 14px;
      color: var(--text-muted);
      background: transparent;
      transition: all var(--transition-fast);
      flex-shrink: 0;
      cursor: pointer;

      &:hover {
        background: rgba(var(--error-rgb), 0.15);
        color: var(--error-color);
      }
    }

    /* Input Row - Message input area */
    .input-row {
      display: flex;
      gap: var(--spacing-sm);
      align-items: flex-end;
    }

    .message-input {
      flex: 1;
      min-height: 46px;
      max-height: 200px;
      padding: var(--spacing-sm) var(--spacing-md);
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      resize: none;
      line-height: 1.5;
      font-family: var(--font-display);
      font-size: 14px;
      color: var(--text-primary);
      transition: all var(--transition-fast);

      &::placeholder {
        color: var(--text-muted);
      }

      &:focus {
        outline: none;
        border-color: var(--primary-color);
        box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.15);
      }

      &:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
    }

    /* Action Buttons - Attach and Send */
    .btn-attach {
      width: 46px;
      height: 46px;
      border-radius: var(--radius-md);
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      color: var(--text-muted);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all var(--transition-fast);
      flex-shrink: 0;
      cursor: pointer;

      &:hover:not(:disabled) {
        background: var(--bg-hover);
        border-color: var(--border-color);
        color: var(--secondary-color);
      }

      &:disabled {
        opacity: 0.3;
        cursor: not-allowed;
      }
    }

    .attach-icon {
      font-size: 22px;
      font-weight: 300;
      line-height: 1;
    }

    .btn-send {
      width: 46px;
      height: 46px;
      border-radius: var(--radius-md);
      background: linear-gradient(135deg, var(--primary-color) 0%, var(--primary-hover) 100%);
      border: none;
      color: var(--bg-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all var(--transition-fast);
      flex-shrink: 0;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(var(--primary-rgb), 0.3);

      &:hover:not(:disabled) {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(var(--primary-rgb), 0.4);
      }

      &:disabled {
        opacity: 0.3;
        cursor: not-allowed;
        transform: none;
      }
    }

    .send-icon {
      font-size: 18px;
      font-weight: bold;
    }

    /* Input Hints - Keyboard shortcuts */
    .input-hints {
      display: flex;
      justify-content: space-between;
      margin-top: var(--spacing-sm);
      padding: 0 var(--spacing-xs);
    }

    .hint {
      font-family: var(--font-mono);
      font-size: 10px;
      letter-spacing: 0.03em;
      color: var(--text-muted);
    }

    .hint-interrupt {
      color: var(--primary-color);
      font-weight: 600;
      animation: pulse 2s ease-in-out infinite;
    }

    /* Queue Indicator - Message queue status */
    .queue-indicator {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      margin-top: var(--spacing-sm);
      padding: var(--spacing-sm);
      background: rgba(var(--primary-rgb), 0.1);
      border: 1px solid rgba(var(--primary-rgb), 0.3);
      border-radius: var(--radius-md);
      font-size: 12px;
      animation: fadeIn 0.2s ease-out;
    }

    .queue-badge {
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 22px;
      height: 22px;
      padding: 0 8px;
      background: linear-gradient(135deg, var(--primary-color) 0%, var(--primary-hover) 100%);
      color: var(--bg-primary);
      border-radius: 11px;
      font-family: var(--font-mono);
      font-weight: 700;
      font-size: 11px;
      letter-spacing: 0.02em;
    }

    .queue-text {
      color: var(--primary-color);
      font-family: var(--font-display);
      font-weight: 600;
      font-size: 12px;
    }

    /* Command Suggestions - Autocomplete dropdown */
    .command-suggestions {
      position: absolute;
      bottom: 100%;
      left: 0;
      right: 0;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      margin-bottom: var(--spacing-sm);
      max-height: 260px;
      overflow-y: auto;
      box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.2);
      z-index: 100;
      animation: fadeInUp 0.15s ease-out;
    }

    .command-suggestions::-webkit-scrollbar {
      width: 4px;
    }

    .command-suggestions::-webkit-scrollbar-thumb {
      background: var(--border-color);
      border-radius: 2px;
    }

    .suggestion-item {
      width: 100%;
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      padding: var(--spacing-sm) var(--spacing-md);
      background: transparent;
      border: none;
      text-align: left;
      cursor: pointer;
      transition: background var(--transition-fast);
      border-bottom: 1px solid var(--border-subtle);

      &:last-child {
        border-bottom: none;
      }

      &:hover {
        background: var(--bg-hover);
      }

      &.selected {
        background: rgba(var(--primary-rgb), 0.1);
      }
    }

    .cmd-name {
      font-family: var(--font-mono);
      font-weight: 600;
      font-size: 12px;
      letter-spacing: 0.02em;
      color: var(--primary-color);
      white-space: nowrap;
    }

    .cmd-desc {
      font-size: 12px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InputPanelComponent implements OnDestroy {
  private commandStore = inject(CommandStore);
  private draftService = inject(DraftService);
  private filePreviewUrls = new Map<File, string>();

  instanceId = input.required<string>();
  disabled = input<boolean>(false);
  placeholder = input<string>('Send a message...');
  pendingFiles = input<File[]>([]);
  pendingFolders = input<string[]>([]);
  queuedCount = input<number>(0);
  isBusy = input<boolean>(false);

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

  message = signal('');
  showCommandSuggestions = signal(false);
  selectedCommandIndex = signal(0);
  private previousInstanceId: string | null = null;

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

  constructor() {
    // Load commands on init
    this.commandStore.loadCommands();

    // Persist message drafts per instance - load draft when instance changes
    effect(() => {
      const currentId = this.instanceId();

      // Save draft for previous instance before switching
      if (this.previousInstanceId && this.previousInstanceId !== currentId) {
        const currentMessage = this.message();
        this.draftService.setDraft(this.previousInstanceId, currentMessage);
      }

      // Load draft for new instance
      const savedDraft = this.draftService.getDraft(currentId);
      this.message.set(savedDraft);
      this.previousInstanceId = currentId;
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
    const textarea = event.target as HTMLTextAreaElement;
    const value = textarea.value;
    this.message.set(value);

    // Save draft as user types
    this.draftService.setDraft(this.instanceId(), value);

    // Show command suggestions when typing "/"
    if (value.startsWith('/') && !value.includes('\n')) {
      this.showCommandSuggestions.set(true);
      this.selectedCommandIndex.set(0);
    } else {
      this.showCommandSuggestions.set(false);
    }

    // Auto-resize textarea - debounced via requestAnimationFrame to avoid blocking input
    this.scheduleTextareaResize(textarea);
  }

  private resizeScheduled = false;
  private scheduleTextareaResize(textarea: HTMLTextAreaElement): void {
    if (this.resizeScheduled) return;
    this.resizeScheduled = true;

    requestAnimationFrame(() => {
      this.resizeScheduled = false;
      // Only set height once to minimize reflow
      const newHeight = Math.min(textarea.scrollHeight, 200);
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
        case 'Enter':
          event.preventDefault();
          const selected = commands[this.selectedCommandIndex()];
          if (selected) {
            this.onSelectCommand(selected);
          }
          return;

        case 'Escape':
          event.preventDefault();
          this.showCommandSuggestions.set(false);
          return;
      }
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
    this.draftService.clearDraft(this.instanceId());

    // Reset textarea height
    const textarea = document.querySelector('.message-input') as HTMLTextAreaElement;
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
      const args = parts.slice(1);

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

    // Clear draft for this instance
    this.draftService.clearDraft(this.instanceId());

    // Reset textarea height
    const textarea = document.querySelector('.message-input') as HTMLTextAreaElement;
    if (textarea) {
      textarea.style.height = 'auto';
    }
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
}
