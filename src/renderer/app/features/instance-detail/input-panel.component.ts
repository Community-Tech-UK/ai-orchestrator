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
import { ProviderStateService } from '../../core/services/provider-state.service';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { SettingsStore } from '../../core/state/settings.store';
import type { CommandTemplate } from '../../../../shared/types/command.types';
import type {
  InstanceProvider,
  InstanceStatus,
  OutputMessage
} from '../../core/state/instance/instance.types';

@Component({
  selector: 'app-input-panel',
  standalone: true,
  imports: [ProviderSelectorComponent, CopilotModelSelectorComponent],
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

      @if (isDraftComposer()) {
        <div class="composer-toolbar draft-mode">
          <div class="composer-defaults">
            <div class="default-controls">
              <app-provider-selector
                [provider]="selectedProvider()"
                (providerSelected)="onProviderSelected($event)"
              />
              @if (selectedProvider() === 'copilot') {
                <app-copilot-model-selector
                  [model]="selectedModel()"
                  (modelSelected)="onModelSelected($event)"
                />
              }
              <button
                class="yolo-toggle"
                [class.active]="effectiveYoloMode()"
                (click)="onToggleYoloMode()"
                [title]="effectiveYoloMode() ? 'YOLO mode ON — auto-approve all actions' : 'YOLO mode OFF — will prompt for approvals'"
              >
                <span class="yolo-icon">{{ effectiveYoloMode() ? '⚡' : '🛡️' }}</span>
                <span class="yolo-label">YOLO {{ effectiveYoloMode() ? 'ON' : 'OFF' }}</span>
              </button>
            </div>
          </div>
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

      <!-- Edit mode indicator -->
      @if (editMode()) {
        <div class="edit-mode-bar">
          @if (isBusy()) {
            <span>Instance is busy — wait for completion before resending · Esc to cancel</span>
          } @else {
            <span>Editing last message · Enter to resend · Esc to cancel</span>
          }
        </div>
      }

      <!-- Input area -->
      <div class="input-row">
        <div class="textarea-wrapper" [class.has-ghost]="showGhostText()">
          @if (showGhostText()) {
            <div class="ghost-text" aria-hidden="true">
              <span class="ghost-invisible">{{ message() }}</span><span class="ghost-visible">{{ ghostRemainder() }}</span>
            </div>
          }
          <textarea
            class="message-input"
            [class.has-ghost]="showGhostText()"
            [placeholder]="showGhostText() ? '' : placeholder()"
            [disabled]="disabled()"
            [value]="message()"
            (input)="onInput($event)"
            (keydown)="onKeyDown($event)"
            (focus)="onFocus()"
            (blur)="onBlur()"
            rows="5"
            #textareaRef
          ></textarea>
        </div>

        <div class="composer-footer">
          <div class="composer-actions-left">
            <button
              class="btn-attach"
              [disabled]="disabled()"
              (click)="onAddFiles()"
              title="Add files"
            >
              <span class="attach-icon">+</span>
            </button>
          </div>

          <div class="input-hints">
            @if (showGhostText()) {
              <span class="hint hint-ghost">Tab or → to accept suggestion</span>
            } @else {
              <span class="hint">Press Enter to send, Shift+Enter for new line</span>
            }
            @if (isInitializing()) {
              <span class="hint hint-starting">Starting up...</span>
            } @else if (isRespawning()) {
              <span class="hint hint-respawning">Resuming session...</span>
            } @else if (isBusy()) {
              <span class="hint hint-interrupt">Press Esc to interrupt</span>
            } @else if (isReplayFallback()) {
              <span class="hint hint-recovery">Context not restored — re-summarize to continue</span>
            } @else {
              <span class="hint">Type / for commands, Cmd+K for palette</span>
            }
          </div>

          <div class="composer-actions-right">
            <button
              class="btn-send"
              [disabled]="disabled() || !canSend() || isInitializing()"
              (click)="onSend()"
              title="Send message (Enter)"
            >
              <span class="send-icon">↑</span>
            </button>
          </div>
        </div>
      </div>

      @if (queuedMessages().length > 0) {
        <div class="queue-section">
          <div class="queue-header">
            <span class="queue-badge">{{ queuedMessages().length }}</span>
            <span class="queue-text">message{{ queuedMessages().length > 1 ? 's' : '' }} queued</span>
          </div>
          <div class="queued-messages">
            @for (queuedMsg of queuedMessages(); track $index; let i = $index) {
              <div class="queued-message-item">
                <span class="queued-message-text" [title]="queuedMsg.message">
                  {{ truncateMessage(queuedMsg.message) }}
                </span>
                @if (queuedMsg.files && queuedMsg.files.length > 0) {
                  <span class="queued-file-count" title="Attached files">
                    📎{{ queuedMsg.files.length }}
                  </span>
                }
                <button
                  class="queued-cancel-btn"
                  (click)="onCancelQueuedMessage(i)"
                  title="Cancel and restore to input"
                >
                  ×
                </button>
              </div>
            }
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    /* Input Panel - Refined message composer */
    .input-panel {
      position: relative;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.028), rgba(255, 255, 255, 0)),
        rgba(11, 16, 15, 0.9);
      border-radius: 22px;
      padding: 14px 14px 12px;
      border: 1px solid rgba(255, 255, 255, 0.07);
      box-shadow:
        0 22px 54px rgba(0, 0, 0, 0.22),
        inset 0 1px 0 rgba(255, 255, 255, 0.02);
      backdrop-filter: blur(22px);
    }

    .composer-toolbar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--spacing-md);
      flex-wrap: wrap;
      margin-bottom: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }

    .composer-toolbar.draft-mode {
      justify-content: flex-start;
    }

    .composer-defaults {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .default-controls {
      display: flex;
      align-items: flex-start;
      gap: var(--spacing-sm);
      flex-wrap: wrap;
    }

    app-copilot-model-selector {
      width: min(320px, 100%);
    }

    .yolo-toggle {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: transparent;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.06em;
      cursor: pointer;
      transition: all var(--transition-fast);
      text-transform: uppercase;

      &:hover {
        border-color: rgba(255, 255, 255, 0.15);
        background: rgba(255, 255, 255, 0.03);
      }

      &.active {
        border-color: rgba(var(--primary-rgb), 0.4);
        background: rgba(var(--primary-rgb), 0.1);
        color: var(--primary-color);
      }
    }

    .yolo-icon {
      font-size: 12px;
      line-height: 1;
    }

    .yolo-label {
      line-height: 1;
    }

    /* Pending Files - Attachment preview area */
    .pending-files {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-sm);
      margin-bottom: 16px;
      padding-bottom: 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      animation: fadeIn 0.2s ease-out;
    }

    .file-chip {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      padding: var(--spacing-xs) var(--spacing-sm);
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 14px;
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
      background: rgba(255, 255, 255, 0.04);
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.07);
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
      flex-direction: column;
      gap: 10px;
      min-height: 180px;
    }

    /* Textarea Wrapper - Container for ghost text overlay */
    .textarea-wrapper {
      position: relative;
      display: block;
      flex: 1;
      min-width: 0;
      min-height: clamp(148px, 20vh, 220px);
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 26px;
      overflow: hidden;
      transition: all var(--transition-fast);
      box-sizing: border-box;
    }

    .textarea-wrapper.has-ghost {
      background: rgba(255, 255, 255, 0.035);
    }

    .textarea-wrapper:focus-within {
      border-color: rgba(var(--primary-rgb), 0.26);
      box-shadow:
        0 0 0 3px rgba(var(--primary-rgb), 0.08),
        0 18px 36px rgba(0, 0, 0, 0.16);
    }

    .message-input {
      width: 100%;
      min-height: clamp(148px, 20vh, 220px);
      max-height: min(40vh, 520px);
      padding: 20px 22px;
      background: transparent;
      border: none;
      border-radius: 26px;
      resize: none;
      line-height: 1.5;
      font-family: var(--font-display);
      font-size: 15px;
      color: var(--text-primary);
      transition: color var(--transition-fast);
      position: relative;
      z-index: 2;
      box-sizing: border-box;
      overflow-y: auto;

      &::placeholder {
        color: var(--text-muted);
      }

      &:focus {
        outline: none;
        box-shadow: none;
      }

      &:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      &.has-ghost {
        background: transparent;
      }
    }

    /* Ghost Text Overlay - Faded suggestion behind textarea */
    .ghost-text {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      padding: 20px 22px;
      pointer-events: none;
      z-index: 1;
      overflow: hidden;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--font-display);
      font-size: 15px;
      line-height: 1.5;
      border: 1px solid transparent; /* Match textarea border space */
      box-sizing: border-box;
    }

    .ghost-invisible {
      visibility: hidden;
      white-space: pre-wrap;
    }

    .ghost-visible {
      color: var(--text-muted);
      opacity: 0.5;
    }

    .hint-ghost {
      color: var(--text-muted);
      opacity: 0.7;
    }

    /* Action Buttons - Attach and Send */
    .composer-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 28px;
      padding: 0 4px;
      min-width: 0;
    }

    .composer-actions-left,
    .composer-actions-right {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .btn-attach {
      width: auto;
      height: auto;
      padding: 0 6px 0 0;
      border-radius: 0;
      background: transparent;
      border: none;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all var(--transition-fast);
      cursor: pointer;

      &:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.05);
        color: var(--text-primary);
      }

      &:disabled {
        opacity: 0.3;
        cursor: not-allowed;
      }
    }

    .attach-icon {
      display: block;
      font-size: 22px;
      font-weight: 300;
      line-height: 1;
      transform: translateY(-2px);
    }

    .btn-send {
      width: 34px;
      height: 34px;
      border-radius: 999px;
      background: rgba(var(--primary-rgb), 0.1);
      border: 1px solid rgba(var(--primary-rgb), 0.16);
      color: rgba(243, 239, 229, 0.86);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all var(--transition-fast);
      cursor: pointer;

      &:hover:not(:disabled) {
        background: rgba(var(--primary-rgb), 0.15);
        border-color: rgba(var(--primary-rgb), 0.24);
        color: var(--text-primary);
      }

      &:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }
    }

    .send-icon {
      font-size: 16px;
      font-weight: 600;
      line-height: 1;
    }

    /* Input Hints - Keyboard shortcuts */
    .input-hints {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex: 1;
      min-width: 0;
      gap: 12px;
      white-space: nowrap;
    }

    .hint {
      font-family: var(--font-mono);
      font-size: 9px;
      letter-spacing: 0.02em;
      line-height: 1;
      color: var(--text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .hint-interrupt {
      color: var(--primary-color);
      font-weight: 600;
      animation: pulse 2s ease-in-out infinite;
    }

    .hint-respawning {
      color: #8b5cf6; /* Purple - same as status indicator */
      font-weight: 600;
      animation: pulse 2s ease-in-out infinite;
    }

    .hint-starting {
      color: rgba(168, 176, 164, 0.7);
      font-weight: 600;
      animation: pulse 2s ease-in-out infinite;
    }

    .hint-recovery {
      color: rgba(245, 158, 11, 0.7);
      font-weight: 600;
    }

    /* Queue Section - Message queue display */
    .queue-section {
      margin-top: var(--spacing-sm);
      background: rgba(var(--primary-rgb), 0.08);
      border: 1px solid rgba(var(--primary-rgb), 0.18);
      border-radius: 18px;
      overflow: hidden;
      animation: fadeIn 0.2s ease-out;
    }

    .queue-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm);
      border-bottom: 1px solid rgba(var(--primary-rgb), 0.2);
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

    .queued-messages {
      max-height: 150px;
      overflow-y: auto;
    }

    .queued-message-item {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-xs) var(--spacing-sm);
      border-bottom: 1px solid rgba(var(--primary-rgb), 0.1);
      transition: background var(--transition-fast);

      &:last-child {
        border-bottom: none;
      }

      &:hover {
        background: rgba(var(--primary-rgb), 0.05);
      }
    }

    .queued-message-text {
      flex: 1;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-secondary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .queued-file-count {
      font-size: 11px;
      color: var(--text-muted);
      flex-shrink: 0;
    }

    .queued-cancel-btn {
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      border: none;
      font-size: 14px;
      color: var(--text-muted);
      background: transparent;
      cursor: pointer;
      flex-shrink: 0;
      transition: all var(--transition-fast);

      &:hover {
        background: rgba(var(--warning-rgb, 255, 183, 77), 0.2);
        color: var(--warning-color, #ffb74d);
      }
    }

    /* Command Suggestions - Autocomplete dropdown */
    .command-suggestions {
      position: absolute;
      bottom: 100%;
      left: 0;
      right: 0;
      background: rgba(11, 16, 15, 0.96);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 18px;
      margin-bottom: var(--spacing-sm);
      max-height: 260px;
      overflow-y: auto;
      box-shadow: 0 -12px 28px rgba(0, 0, 0, 0.22);
      z-index: 100;
      animation: fadeInUp 0.15s ease-out;
      backdrop-filter: blur(18px);
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

    .edit-mode-bar {
      display: flex;
      align-items: center;
      padding: 6px 12px;
      margin-bottom: 8px;
      border-radius: 8px;
      background: rgba(var(--primary-rgb), 0.08);
      border: 1px solid rgba(var(--primary-rgb), 0.15);
      font-family: var(--font-mono);
      font-size: 11px;
      letter-spacing: 0.02em;
      color: var(--text-muted);

      span {
        opacity: 0.85;
      }
    }
  `],
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
  resendEdited = output<{ messageIndex: number; text: string }>();

  editMode = signal(false);
  private stashedDraft = signal<string | null>(null);
  private editMessageIndex = signal<number | null>(null);

  private lastUserMessage = computed(() => {
    const msgs = this.outputMessages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].type === 'user') {
        return { text: msgs[i].content, bufferIndex: i };
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
      ? (this.newSessionDraft.model() ?? this.providerState.selectedModel())
      : this.providerState.selectedModel()
  );

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
      this.draftService.version();
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
      if (status === 'busy' || status === 'initializing' || status === 'waking' || currentText) {
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

  private enterEditMode(): void {
    const last = this.lastUserMessage();
    if (!last || this.editMode()) return;

    this.stashedDraft.set(this.message());
    this.message.set(last.text);
    this.editMessageIndex.set(last.bufferIndex);
    this.editMode.set(true);

    // Place cursor at end of loaded text
    requestAnimationFrame(() => {
      const textarea = this.textareaRef()?.nativeElement;
      if (textarea) {
        textarea.value = last.text;
        textarea.selectionStart = last.text.length;
        textarea.selectionEnd = last.text.length;
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
    if (!this.canSend() || this.isBusy() || this.disabled()) return;

    const idx = this.editMessageIndex();
    if (idx === null) return;

    this.resendEdited.emit({
      messageIndex: idx,
      text: this.message().trim(),
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
