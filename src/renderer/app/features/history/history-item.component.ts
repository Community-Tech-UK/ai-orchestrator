/**
 * History Item Component - Individual entry in the history list
 */

import { ChangeDetectionStrategy, Component, computed, input, output, signal, inject } from '@angular/core';
import { DatePipe, CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { HistoryStore } from '../../core/state/history.store';
import { SessionShareIpcService } from '../../core/services/ipc/session-share-ipc.service';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import type { OutputMessage } from '../../core/state/instance/instance.types';
import type { SessionShareBundle } from '../../../../shared/types/session-share.types';

@Component({
  selector: 'app-history-item',
  standalone: true,
  imports: [DatePipe, CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="history-item"
      [class.error]="entry().status === 'error'"
      [class.expanded]="isExpanded()"
    >
      <div
        class="item-header"
        (click)="toggleExpand()"
        (keydown.enter)="toggleExpand()"
        (keydown.space)="$event.preventDefault(); toggleExpand()"
        tabindex="0"
        role="button"
        [attr.aria-label]="'Expand conversation: ' + entry().displayName"
        [attr.aria-expanded]="isExpanded()"
      >
        <span class="expand-icon">{{ isExpanded() ? '▼' : '▶' }}</span>

          <div class="header-content">
            <div class="header-top">
              <span class="display-name">{{ entry().displayName }}</span>
              <div class="header-actions">
              <button
                class="btn-share"
                (click)="onShare($event)"
                title="Save redacted share bundle"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="18" cy="5" r="3"></circle>
                  <circle cx="6" cy="12" r="3"></circle>
                  <circle cx="18" cy="19" r="3"></circle>
                  <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
                  <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
                </svg>
              </button>
              <button
                class="btn-observer"
                (click)="onOpenReplay($event)"
                title="Open replay view"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path>
                  <circle cx="12" cy="12" r="3"></circle>
                </svg>
              </button>
              <button
                class="btn-restore"
                (click)="onRestore($event)"
                title="Restore to new instance"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="23 4 23 10 17 10"></polyline>
                  <polyline points="1 20 1 14 7 14"></polyline>
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                </svg>
              </button>
              <button
                class="btn-delete"
                (click)="onDelete($event)"
                title="Delete"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
              </button>
            </div>
          </div>

          <p class="preview">{{ entry().firstUserMessage || 'No message preview' }}</p>

          <div class="item-meta">
            <span class="date">{{ entry().endedAt | date:'MMM d, h:mm a' }}</span>
            <span class="message-count">{{ entry().messageCount }} messages</span>
            @if (entry().status === 'error') {
              <span class="status-badge error">Error</span>
            }
          </div>

          <div class="working-dir" title="{{ entry().workingDirectory }}">
            {{ shortenPath(entry().workingDirectory) }}
          </div>

          @if (actionFeedback()) {
            <p class="action-feedback">{{ actionFeedback() }}</p>
          }
        </div>
      </div>

      @if (isExpanded()) {
        <div class="item-content">
          @if (bundlePreview()) {
            <div class="replay-summary">
              <div class="summary-chip">
                <span>Artifacts</span>
                <strong>{{ bundlePreview()!.summary.artifactCount }}</strong>
              </div>
              <div class="summary-chip">
                <span>Attachments</span>
                <strong>{{ bundlePreview()!.summary.attachmentCount }}</strong>
              </div>
              <div class="summary-chip">
                <span>Snapshots</span>
                <strong>
                  {{ bundlePreview()!.summary.continuitySnapshotCount + bundlePreview()!.summary.fileSnapshotSessionCount }}
                </strong>
              </div>
              <div class="summary-chip">
                <span>Redactions</span>
                <strong>{{ bundlePreview()!.summary.redactedContentCount }}</strong>
              </div>
            </div>

            @if (previewArtifacts().length > 0) {
              <div class="artifact-preview-list">
                @for (artifact of previewArtifacts(); track artifact.id) {
                  <article class="artifact-preview">
                    <div class="message-header">
                      <span class="role-label">{{ artifact.type }}</span>
                      @if (artifact.fileLabel) {
                        <span class="timestamp">{{ artifact.fileLabel }}</span>
                      }
                    </div>
                    <strong>{{ artifact.title }}</strong>
                    <div class="message-content">{{ artifact.content }}</div>
                  </article>
                }
              </div>
            }

            @if (bundlePreview()!.warnings.length > 0) {
              <p class="warning-text">{{ bundlePreview()!.warnings[0] }}</p>
            }
          }

          @if (isLoading()) {
            <div class="loading">
              <div class="spinner"></div>
              <span>Loading conversation...</span>
            </div>
          } @else if (messages().length > 0) {
            <div class="messages">
              @for (msg of messages(); track msg.id) {
                <div class="message" [class]="msg.type">
                  <div class="message-header">
                    <span class="role-label">{{ getRoleLabel(msg.type) }}</span>
                    <span class="timestamp">{{ msg.timestamp | date:'MMM d, h:mm a' }}</span>
                  </div>
                  <div class="message-content">{{ msg.content }}</div>
                </div>
              }
            </div>
          } @else {
            <div class="empty-state">No messages found</div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .history-item {
      background: var(--bg-secondary);
      border-radius: var(--radius-md);
      transition: all var(--transition-fast);
      border: 1px solid transparent;
      margin-bottom: var(--spacing-sm);

      &:hover {
        border-color: var(--border-color);
      }

      &.error {
        border-left: 3px solid var(--error-color);
      }

      &.expanded {
        background: var(--bg-tertiary);
        border-color: var(--border-color);
      }
    }

    .item-header {
      display: flex;
      align-items: flex-start;
      gap: var(--spacing-sm);
      padding: var(--spacing-md);
      cursor: pointer;
      transition: background var(--transition-fast);

      &:hover {
        background: var(--bg-tertiary);
      }

      &:focus {
        outline: 2px solid var(--primary-color);
        outline-offset: -2px;
      }
    }

    .expand-icon {
      flex-shrink: 0;
      width: 12px;
      font-size: 10px;
      color: var(--text-muted);
      margin-top: 2px;
      transition: transform var(--transition-fast);
    }

    .header-content {
      flex: 1;
      min-width: 0;
    }

    .header-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--spacing-xs);
      gap: var(--spacing-sm);
    }

    .display-name {
      font-weight: 500;
      color: var(--text-primary);
      font-size: 14px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    .header-actions {
      display: flex;
      gap: var(--spacing-xs);
      opacity: 0;
      transition: opacity var(--transition-fast);

      .history-item:hover & {
        opacity: 1;
      }
    }

    .btn-share,
    .btn-observer,
    .btn-restore,
    .btn-delete {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      background: transparent;
      border: none;
      border-radius: var(--radius-sm);
      color: var(--text-muted);
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        color: var(--text-primary);
      }
    }

    .btn-share:hover {
      background: rgba(34, 197, 94, 0.18);
      color: #86efac;
    }

    .btn-observer:hover {
      background: rgba(56, 189, 248, 0.18);
      color: #bae6fd;
    }

    .btn-restore:hover {
      background: var(--primary-color);
      color: white;
    }

    .btn-delete:hover {
      background: var(--error-color);
      color: white;
    }

    .preview {
      margin: 0 0 var(--spacing-sm);
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.4;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .item-meta {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      font-size: 11px;
      color: var(--text-muted);
      margin-bottom: var(--spacing-xs);
    }

    .status-badge {
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      font-weight: 500;

      &.error {
        background: rgba(239, 68, 68, 0.1);
        color: var(--error-color);
      }
    }

    .working-dir {
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .action-feedback {
      margin-top: var(--spacing-xs);
      font-size: 11px;
      color: #86efac;
    }

    .item-content {
      border-top: 1px solid var(--border-color);
      max-height: 400px;
      overflow-y: auto;
      background: var(--bg-primary);
    }

    .replay-summary,
    .artifact-preview-list {
      display: grid;
      gap: var(--spacing-sm);
      padding: var(--spacing-md);
    }

    .replay-summary {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      padding-bottom: 0;
    }

    .summary-chip,
    .artifact-preview {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: rgba(15, 23, 42, 0.4);
      padding: var(--spacing-sm);
    }

    .summary-chip {
      display: grid;
      gap: 2px;
      font-size: 11px;
      color: var(--text-muted);
    }

    .summary-chip strong,
    .artifact-preview strong {
      color: var(--text-primary);
      font-size: 12px;
    }

    .artifact-preview {
      display: grid;
      gap: var(--spacing-xs);
    }

    .warning-text {
      margin: 0;
      padding: 0 var(--spacing-md) var(--spacing-md);
      font-size: 11px;
      color: #fbbf24;
    }

    .loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: var(--spacing-xl);
      gap: var(--spacing-sm);
      color: var(--text-muted);
      font-size: 13px;
    }

    .spinner {
      width: 20px;
      height: 20px;
      border: 2px solid var(--border-color);
      border-top-color: var(--primary-color);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .messages {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      padding: var(--spacing-md);
    }

    .message {
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: var(--radius-sm);
      border-left: 3px solid transparent;

      &.user {
        background: rgba(59, 130, 246, 0.1);
        border-left-color: #3b82f6;
      }

      &.assistant {
        background: rgba(139, 92, 246, 0.1);
        border-left-color: #8b5cf6;
      }

      &.system {
        background: rgba(156, 163, 175, 0.1);
        border-left-color: #9ca3af;
      }

      &.tool_use,
      &.tool_result {
        background: rgba(16, 185, 129, 0.1);
        border-left-color: #10b981;
      }

      &.error {
        background: rgba(239, 68, 68, 0.1);
        border-left-color: var(--error-color);
      }
    }

    .message-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--spacing-xs);
    }

    .role-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
    }

    .timestamp {
      font-size: 10px;
      color: var(--text-muted);
    }

    .message-content {
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-primary);
      white-space: pre-wrap;
      word-break: break-word;
    }

    .empty-state {
      padding: var(--spacing-xl);
      text-align: center;
      color: var(--text-muted);
      font-size: 13px;
    }
  `],
})
export class HistoryItemComponent {
  entry = input.required<ConversationHistoryEntry>();

  selectEntry = output<ConversationHistoryEntry>();
  deleteEntry = output<ConversationHistoryEntry>();

  private historyStore = inject(HistoryStore);
  private router = inject(Router);
  private sessionShare = inject(SessionShareIpcService);

  isExpanded = signal(false);
  isLoading = signal(false);
  messages = signal<OutputMessage[]>([]);
  actionFeedback = signal('');
  bundlePreview = signal<SessionShareBundle | null>(null);
  previewArtifacts = computed(() => this.bundlePreview()?.artifacts.slice(0, 3) ?? []);

  async toggleExpand(): Promise<void> {
    if (!this.isExpanded()) {
      this.isExpanded.set(true);
      this.isLoading.set(true);
      this.bundlePreview.set(null);

      try {
        const [conversation, previewResponse] = await Promise.all([
          this.historyStore.loadConversation(this.entry().id),
          this.sessionShare.previewForHistory(this.entry().id),
        ]);

        if (conversation?.messages) {
          this.messages.set(conversation.messages);
        }

        if (previewResponse.success && previewResponse.data) {
          this.bundlePreview.set(previewResponse.data as SessionShareBundle);
        }
      } finally {
        this.isLoading.set(false);
      }
    } else {
      this.isExpanded.set(false);
    }
  }

  onRestore(event: MouseEvent): void {
    event.stopPropagation();
    this.selectEntry.emit(this.entry());
  }

  onDelete(event: MouseEvent): void {
    event.stopPropagation();
    this.deleteEntry.emit(this.entry());
  }

  async onShare(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    this.actionFeedback.set('');

    const response = await this.sessionShare.saveForHistory(this.entry().id);
    if (!response.success || !response.data || typeof response.data !== 'object') {
      this.actionFeedback.set(response.error?.message || 'Share bundle export failed.');
      return;
    }

    const filePath = (response.data as { filePath?: string }).filePath;
    this.actionFeedback.set(filePath ? `Saved ${filePath}` : 'Saved share bundle.');
  }

  onOpenReplay(event: MouseEvent): void {
    event.stopPropagation();
    void this.router.navigate(['/replay'], {
      queryParams: { entryId: this.entry().id },
    });
  }

  getRoleLabel(type: string): string {
    const labels: Record<string, string> = {
      user: 'User',
      assistant: 'Assistant',
      system: 'System',
      tool_use: 'Tool Use',
      tool_result: 'Tool Result',
      error: 'Error'
    };
    return labels[type] || type;
  }

  shortenPath(path: string): string {
    const parts = path.split('/');
    if (parts.length <= 3) return path;
    return `.../${parts.slice(-2).join('/')}`;
  }
}
