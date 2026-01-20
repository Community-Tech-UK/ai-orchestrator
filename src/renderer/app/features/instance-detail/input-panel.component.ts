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
import type { CommandTemplate } from '../../../../shared/types/command.types';

@Component({
  selector: 'app-input-panel',
  standalone: true,
  template: `
    <div class="input-panel">
      <!-- Pending files preview -->
      @if (pendingFilePreviews().length > 0) {
        <div class="pending-files">
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
        @if (disabled()) {
          <span class="hint hint-interrupt">Press Ctrl+C to interrupt</span>
        } @else {
          <span class="hint">Type / for commands, Cmd+K for palette</span>
        }
      </div>
    </div>
  `,
  styles: [`
    .input-panel {
      background: var(--bg-secondary);
      border-radius: var(--radius-md);
      padding: var(--spacing-md);
    }

    .pending-files {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-sm);
      margin-bottom: var(--spacing-sm);
      padding-bottom: var(--spacing-sm);
      border-bottom: 1px solid var(--border-color);
    }

    .file-chip {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      padding: var(--spacing-xs) var(--spacing-sm);
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      font-size: 12px;
    }

    .file-preview-card {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: 6px 8px;
      background: var(--bg-tertiary);
      border-radius: var(--radius-md);
      border: 1px solid var(--border-color);
    }

    .preview-thumbnail {
      width: 48px;
      height: 48px;
      border-radius: var(--radius-sm);
      overflow: hidden;
      flex-shrink: 0;
      background-color: var(--bg-secondary);
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
    }

    .preview-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .preview-info .file-name {
      font-size: 12px;
      font-weight: 500;
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .file-size {
      font-size: 10px;
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
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      font-size: 14px;
      color: var(--text-muted);
      background: transparent;
      transition: all var(--transition-fast);
      flex-shrink: 0;

      &:hover {
        background: var(--error-bg);
        color: var(--error-color);
      }
    }

    .input-row {
      display: flex;
      gap: var(--spacing-sm);
      align-items: flex-end;
    }

    .message-input {
      flex: 1;
      min-height: 44px;
      max-height: 200px;
      padding: var(--spacing-sm) var(--spacing-md);
      resize: none;
      line-height: 1.5;
      font-size: 14px;

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .btn-attach {
      width: 44px;
      height: 44px;
      border-radius: var(--radius-md);
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all var(--transition-fast);
      flex-shrink: 0;

      &:hover:not(:disabled) {
        background: var(--bg-primary);
        color: var(--text-primary);
      }

      &:disabled {
        opacity: 0.3;
        cursor: not-allowed;
      }
    }

    .attach-icon {
      font-size: 24px;
      font-weight: 300;
      line-height: 1;
    }

    .btn-send {
      width: 44px;
      height: 44px;
      border-radius: var(--radius-md);
      background: var(--primary-color);
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all var(--transition-fast);
      flex-shrink: 0;

      &:hover:not(:disabled) {
        background: var(--primary-hover);
      }

      &:disabled {
        opacity: 0.3;
        cursor: not-allowed;
      }
    }

    .send-icon {
      font-size: 20px;
      font-weight: bold;
    }

    .input-hints {
      display: flex;
      justify-content: space-between;
      margin-top: var(--spacing-xs);
      padding: 0 var(--spacing-xs);
    }

    .hint {
      font-size: 11px;
      color: var(--text-muted);
    }

    .hint-interrupt {
      color: var(--warning-color, #d97706);
      font-weight: 500;
    }

    .command-suggestions {
      position: absolute;
      bottom: 100%;
      left: 0;
      right: 0;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      margin-bottom: var(--spacing-xs);
      max-height: 240px;
      overflow-y: auto;
      box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.15);
      z-index: 100;
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

      &:hover,
      &.selected {
        background: var(--bg-secondary);
      }

      &.selected {
        background: var(--bg-tertiary);
      }
    }

    .cmd-name {
      font-weight: 600;
      color: var(--primary-color);
      font-family: var(--font-mono);
      white-space: nowrap;
    }

    .cmd-desc {
      font-size: 13px;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .input-panel {
      position: relative;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InputPanelComponent implements OnDestroy {
  private commandStore = inject(CommandStore);
  private filePreviewUrls = new Map<File, string>();

  instanceId = input.required<string>();
  disabled = input<boolean>(false);
  placeholder = input<string>('Send a message...');
  pendingFiles = input<File[]>([]);

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
  addFiles = output<void>();

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

  constructor() {
    // Load commands on init
    this.commandStore.loadCommands();

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
    return this.message().trim().length > 0 || this.pendingFilePreviews().length > 0;
  }

  onInput(event: Event): void {
    const textarea = event.target as HTMLTextAreaElement;
    const value = textarea.value;
    this.message.set(value);

    // Show command suggestions when typing "/"
    if (value.startsWith('/') && !value.includes('\n')) {
      this.showCommandSuggestions.set(true);
      this.selectedCommandIndex.set(0);
    } else {
      this.showCommandSuggestions.set(false);
    }

    // Auto-resize textarea
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
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

    // Clear input
    this.message.set('');
    this.showCommandSuggestions.set(false);

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
}
