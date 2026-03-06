import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { SessionShareIpcService } from '../../core/services/ipc/session-share-ipc.service';
import { SettingsStore } from '../../core/state/settings.store';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import type { OutputMessage } from '../../core/state/instance/instance.types';
import type {
  SessionShareAttachment,
  SessionShareBundle,
} from '../../../../shared/types/session-share.types';

interface ReplayTimelineEntry {
  id: string;
  kind: 'message' | 'artifact' | 'attachment' | 'continuity' | 'file-session';
  timestamp?: number;
  badge: string;
  title: string;
  detail?: string;
  content?: string;
}

@Component({
  selector: 'app-session-replay-page',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="hero">
        <div>
          <p class="eyebrow">Read-only Observer</p>
          <h1>Replay & Share</h1>
          <p class="subtitle">
            Inspect a live run, archived history entry, or saved share bundle before replaying it locally.
          </p>
        </div>

        <div class="button-row">
          <button class="ghost" type="button" (click)="loadBundleFromDisk()">Load Bundle</button>
          @if (canSaveBundle()) {
            <button class="primary" type="button" (click)="saveBundle()">Save Redacted Bundle</button>
          }
        </div>
      </header>

      @if (error()) {
        <div class="banner error">{{ error() }}</div>
      }

      @if (info()) {
        <div class="banner info">{{ info() }}</div>
      }

      <section class="source-panel">
        <div class="source-row">
          <div>
            <span class="label">Source</span>
            <strong>{{ bundle()?.source?.displayName || 'No source loaded' }}</strong>
          </div>
          <div>
            <span class="label">Type</span>
            <strong>{{ bundle()?.source?.kind || 'n/a' }}</strong>
          </div>
          <div>
            <span class="label">Messages</span>
            <strong>{{ bundle()?.summary?.totalMessages || 0 }}</strong>
          </div>
          <div>
            <span class="label">Artifacts</span>
            <strong>{{ bundle()?.summary?.artifactCount || 0 }}</strong>
          </div>
        </div>

        <div class="source-row">
          <div>
            <span class="label">Workspace</span>
            <strong>{{ bundle()?.source?.workingDirectoryLabel || '[workspace]' }}</strong>
          </div>
          <div>
            <span class="label">Continuity Snapshots</span>
            <strong>{{ bundle()?.summary?.continuitySnapshotCount || 0 }}</strong>
          </div>
          <div>
            <span class="label">File Snapshot Sessions</span>
            <strong>{{ bundle()?.summary?.fileSnapshotSessionCount || 0 }}</strong>
          </div>
          <div>
            <span class="label">Redactions</span>
            <strong>{{ bundle()?.summary?.redactedContentCount || 0 }}</strong>
          </div>
        </div>

        @if (bundle()?.warnings?.length) {
          <ul class="warning-list">
            @for (warning of bundle()!.warnings; track warning) {
              <li>{{ warning }}</li>
            }
          </ul>
        }
      </section>

      <section class="action-panel">
        <label class="field">
          <span>Replay Working Directory</span>
          <input
            type="text"
            [value]="replayWorkingDirectory()"
            (input)="replayWorkingDirectory.set(getInputValue($event))"
            placeholder="/path/to/local/workspace"
          />
        </label>

        <div class="button-row">
          @if (replaySourceInstanceId()) {
            <button class="ghost" type="button" (click)="openSnapshots()">
              Open Snapshots
            </button>
          }
          @if (sourceEntryId()) {
            <button class="primary" type="button" (click)="restoreHistory()" [disabled]="loading()">
              Restore History Session
            </button>
          }

          @if (loadedBundlePath()) {
            <button
              class="primary"
              type="button"
              (click)="replayBundle()"
              [disabled]="loading() || !replayWorkingDirectory().trim()"
            >
              Replay Bundle Locally
            </button>
          }
        </div>
      </section>

      <section class="panel timeline-panel">
        <div class="panel-header">
          <h2>Replay Timeline</h2>
          <span>{{ timelineEntries().length }}</span>
        </div>

        @if (!timelineEntries().length) {
          <p class="empty">No replay events were recorded for this source.</p>
        } @else {
          <div class="timeline-list">
            @for (entry of timelineEntries(); track entry.id) {
              <article class="timeline-entry">
                <div class="message-head">
                  <span class="badge">{{ entry.badge }}</span>
                  <span class="timestamp">{{ formatDate(entry.timestamp) }}</span>
                </div>
                <h3>{{ entry.title }}</h3>
                @if (entry.detail) {
                  <p class="meta">{{ entry.detail }}</p>
                }
                @if (entry.content) {
                  <pre>{{ entry.content }}</pre>
                }
              </article>
            }
          </div>
        }
      </section>

      <div class="content-grid">
        <section class="panel">
          <div class="panel-header">
            <h2>Messages</h2>
            <span>{{ bundle()?.summary?.totalMessages || 0 }}</span>
          </div>

          @if (!bundle()) {
            <p class="empty">Load a source to inspect its replay package.</p>
          } @else {
            <div class="message-list">
              @for (message of bundle()!.messages; track message.id) {
                <article class="message" [class]="message.type">
                  <div class="message-head">
                    <span class="badge">{{ message.type }}</span>
                    <span class="timestamp">{{ formatDate(message.timestamp) }}</span>
                  </div>
                  <pre>{{ message.content }}</pre>
                </article>
              }
            </div>
          }
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2>Artifacts</h2>
            <span>{{ bundle()?.artifacts?.length || 0 }}</span>
          </div>

          @if (!bundle()?.artifacts?.length) {
            <p class="empty">No structured artifacts were included in this run.</p>
          } @else {
            <div class="artifact-list">
              @for (artifact of bundle()!.artifacts; track artifact.id) {
                <article class="artifact">
                  <div class="message-head">
                    <span class="badge">{{ artifact.type }}</span>
                    @if (artifact.severity) {
                      <span class="severity">{{ artifact.severity }}</span>
                    }
                  </div>
                  <h3>{{ artifact.title }}</h3>
                  @if (artifact.fileLabel) {
                    <p class="meta">{{ artifact.fileLabel }}</p>
                  }
                  <pre>{{ artifact.content }}</pre>
                </article>
              }
            </div>
          }
        </section>
      </div>

      <div class="content-grid lower-grid">
        <section class="panel">
          <div class="panel-header">
            <h2>Attachments</h2>
            <span>{{ bundle()?.attachments?.length || 0 }}</span>
          </div>

          @if (!bundle()?.attachments?.length) {
            <p class="empty">No embedded evidence files were captured.</p>
          } @else {
            <div class="attachment-list">
              @for (attachment of bundle()!.attachments; track attachment.id) {
                <article class="artifact">
                  <div class="message-head">
                    <span class="badge">{{ attachment.kind }}</span>
                    @if (attachment.size) {
                      <span class="meta">{{ formatBytes(attachment.size) }}</span>
                    }
                  </div>
                  <h3>{{ attachment.title }}</h3>
                  @if (attachment.sourcePathLabel) {
                    <p class="meta">{{ attachment.sourcePathLabel }}</p>
                  }
                  @if (attachment.embeddedBase64 && attachment.mediaType?.startsWith('image/')) {
                    <img
                      class="attachment-image"
                      [src]="toDataUrl(attachment)"
                      [alt]="attachment.title"
                    />
                  } @else if (attachment.embeddedText) {
                    <pre>{{ attachment.embeddedText }}</pre>
                  } @else {
                    <p class="meta">Metadata only</p>
                  }
                </article>
              }
            </div>
          }
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2>Snapshots</h2>
            <span>
              {{ (bundle()?.continuitySnapshots?.length || 0) + (bundle()?.fileSnapshotSessions?.length || 0) }}
            </span>
          </div>

          <div class="snapshot-stack">
            @if (!bundle()?.continuitySnapshots?.length && !bundle()?.fileSnapshotSessions?.length) {
              <p class="empty">No continuity or file snapshots were available.</p>
            }

            @for (snapshot of bundle()?.continuitySnapshots || []; track snapshot.id) {
              <article class="artifact">
                <div class="message-head">
                  <span class="badge">{{ snapshot.trigger }}</span>
                  <span class="timestamp">{{ formatDate(snapshot.timestamp) }}</span>
                </div>
                <h3>{{ snapshot.name || snapshot.id }}</h3>
                @if (snapshot.description) {
                  <p class="meta">{{ snapshot.description }}</p>
                }
                <p class="meta">{{ snapshot.messageCount }} messages · {{ snapshot.tokensUsed }} tokens</p>
              </article>
            }

            @for (session of bundle()?.fileSnapshotSessions || []; track session.id) {
              <article class="artifact">
                <div class="message-head">
                  <span class="badge">file-session</span>
                  <span class="timestamp">{{ formatDate(session.startedAt) }}</span>
                </div>
                <h3>{{ session.description || session.id }}</h3>
                <p class="meta">
                  {{ session.fileCount }} files · {{ session.snapshotCount }} snapshots
                </p>
              </article>
            }
          </div>
        </section>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      min-height: 100%;
      background:
        radial-gradient(circle at top left, rgba(34, 197, 94, 0.12), transparent 30rem),
        linear-gradient(180deg, #08131d 0%, #0c1723 100%);
      color: #e6eef5;
    }

    .page {
      max-width: 78rem;
      margin: 0 auto;
      padding: 2rem 1.25rem 3rem;
      display: grid;
      gap: 1rem;
    }

    .hero,
    .button-row,
    .source-row,
    .content-grid,
    .panel-header,
    .message-head {
      display: flex;
      gap: 1rem;
      justify-content: space-between;
    }

    .hero {
      align-items: flex-end;
    }

    h1,
    h2,
    h3,
    p {
      margin: 0;
    }

    h1 {
      font-size: clamp(2rem, 4vw, 3rem);
      line-height: 0.98;
    }

    h2 {
      font-size: 1rem;
    }

    h3 {
      font-size: 0.95rem;
    }

    .eyebrow,
    .label {
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-size: 0.72rem;
      color: #9bd3b1;
    }

    .subtitle,
    .meta,
    .timestamp {
      color: #9fb3c7;
    }

    .banner,
    .source-panel,
    .action-panel,
    .panel {
      border: 1px solid rgba(148, 163, 184, 0.16);
      border-radius: 1rem;
      background: rgba(8, 19, 29, 0.86);
      backdrop-filter: blur(10px);
      box-shadow: 0 1rem 2rem rgba(0, 0, 0, 0.18);
    }

    .banner,
    .source-panel,
    .action-panel,
    .panel {
      padding: 1rem;
    }

    .banner.error {
      border-color: rgba(248, 113, 113, 0.3);
      color: #fecaca;
    }

    .banner.info {
      border-color: rgba(74, 222, 128, 0.3);
      color: #bbf7d0;
    }

    .source-panel,
    .action-panel {
      display: grid;
      gap: 1rem;
    }

    .source-row {
      flex-wrap: wrap;
    }

    .source-row > div {
      min-width: 12rem;
      display: grid;
      gap: 0.25rem;
    }

    .warning-list {
      margin: 0;
      padding-left: 1.25rem;
      color: #fcd34d;
    }

    .field {
      display: grid;
      gap: 0.4rem;
      flex: 1;
    }

    input {
      width: 100%;
      padding: 0.8rem 0.9rem;
      border-radius: 0.85rem;
      border: 1px solid rgba(148, 163, 184, 0.2);
      background: rgba(15, 23, 42, 0.72);
      color: #f8fafc;
      font: inherit;
    }

    .content-grid {
      align-items: stretch;
    }

    .content-grid > .panel {
      flex: 1;
      min-width: 0;
    }

    .lower-grid {
      align-items: flex-start;
    }

    .panel {
      display: grid;
      gap: 0.8rem;
      min-height: 18rem;
    }

    .panel-header {
      align-items: center;
      border-bottom: 1px solid rgba(148, 163, 184, 0.12);
      padding-bottom: 0.65rem;
    }

    .message-list,
    .artifact-list,
    .attachment-list,
    .snapshot-stack,
    .timeline-list {
      display: grid;
      gap: 0.75rem;
      overflow: auto;
    }

    .message,
    .artifact,
    .timeline-entry {
      padding: 0.9rem;
      border-radius: 0.85rem;
      border: 1px solid rgba(148, 163, 184, 0.12);
      background: rgba(15, 23, 42, 0.72);
      display: grid;
      gap: 0.5rem;
    }

    .message.user {
      border-left: 3px solid #38bdf8;
    }

    .message.assistant {
      border-left: 3px solid #22c55e;
    }

    .message.tool_result,
    .message.tool_use {
      border-left: 3px solid #f59e0b;
    }

    .message.error {
      border-left: 3px solid #f87171;
    }

    .badge,
    .severity {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      padding: 0.24rem 0.6rem;
      background: rgba(148, 163, 184, 0.16);
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .severity {
      color: #fecaca;
      background: rgba(127, 29, 29, 0.28);
    }

    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font: inherit;
      color: #dbe6ef;
    }

    .attachment-image {
      width: 100%;
      max-height: 24rem;
      object-fit: contain;
      border-radius: 0.75rem;
      background: rgba(255, 255, 255, 0.03);
    }

    .empty {
      color: #9fb3c7;
    }

    button {
      border: 0;
      border-radius: 999px;
      padding: 0.72rem 1rem;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      transition: transform 120ms ease, opacity 120ms ease, background 120ms ease;
    }

    button:hover:not(:disabled) {
      transform: translateY(-1px);
    }

    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .primary {
      background: linear-gradient(135deg, #4ade80 0%, #22c55e 100%);
      color: #08131d;
    }

    .ghost {
      background: rgba(148, 163, 184, 0.14);
      color: #f8fafc;
    }

    @media (max-width: 960px) {
      .hero,
      .content-grid,
      .button-row,
      .source-row,
      .panel-header,
      .message-head {
        flex-direction: column;
        align-items: stretch;
      }
    }
  `],
})
export class SessionReplayPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly fileIpc = inject(FileIpcService);
  private readonly shareIpc = inject(SessionShareIpcService);
  private readonly historyStore = inject(HistoryStore);
  private readonly instanceStore = inject(InstanceStore);
  private readonly settingsStore = inject(SettingsStore);
  private readonly destroyRef = inject(DestroyRef);

  readonly bundle = signal<SessionShareBundle | null>(null);
  readonly error = signal<string | null>(null);
  readonly info = signal<string | null>(null);
  readonly loading = signal(false);
  readonly replayWorkingDirectory = signal('');
  readonly sourceEntryId = signal<string | null>(null);
  readonly sourceInstanceId = signal<string | null>(null);
  readonly loadedBundlePath = signal<string | null>(null);

  readonly canSaveBundle = computed(() => Boolean(this.sourceEntryId() || this.sourceInstanceId()));
  readonly replaySourceInstanceId = computed(() => this.sourceInstanceId() || this.bundle()?.source.instanceId || null);
  readonly timelineEntries = computed<ReplayTimelineEntry[]>(() => {
    const bundle = this.bundle();
    if (!bundle) {
      return [];
    }

    const messageEntries = bundle.messages.map((message) => ({
      id: `message:${message.id}`,
      kind: 'message' as const,
      timestamp: message.timestamp,
      badge: message.type,
      title: this.getTimelineTitleForMessage(message),
      content: message.content,
    }));

    const artifactEntries = bundle.artifacts.map((artifact) => ({
      id: `artifact:${artifact.id}`,
      kind: 'artifact' as const,
      timestamp: artifact.timestamp,
      badge: artifact.type,
      title: artifact.title,
      detail: artifact.fileLabel,
      content: artifact.content,
    }));

    const attachmentEntries = bundle.attachments.map((attachment) => ({
      id: `attachment:${attachment.id}`,
      kind: 'attachment' as const,
      timestamp: attachment.timestamp,
      badge: attachment.kind,
      title: attachment.title,
      detail: attachment.sourcePathLabel,
      content: attachment.embeddedText ? this.truncateText(attachment.embeddedText, 320) : undefined,
    }));

    const continuityEntries = bundle.continuitySnapshots.map((snapshot) => ({
      id: `continuity:${snapshot.id}`,
      kind: 'continuity' as const,
      timestamp: snapshot.timestamp,
      badge: snapshot.trigger,
      title: snapshot.name || snapshot.id,
      detail: snapshot.description || `${snapshot.messageCount} messages · ${snapshot.tokensUsed} tokens`,
    }));

    const fileSessionEntries = bundle.fileSnapshotSessions.map((session) => ({
      id: `file-session:${session.id}`,
      kind: 'file-session' as const,
      timestamp: session.startedAt,
      badge: 'file-session',
      title: session.description || session.id,
      detail: `${session.fileCount} files · ${session.snapshotCount} snapshots`,
    }));

    return [
      ...messageEntries,
      ...artifactEntries,
      ...attachmentEntries,
      ...continuityEntries,
      ...fileSessionEntries,
    ].sort((left, right) => (right.timestamp || 0) - (left.timestamp || 0));
  });

  constructor() {
    const defaultDirectory = this.settingsStore.defaultWorkingDirectory();
    if (defaultDirectory) {
      this.replayWorkingDirectory.set(defaultDirectory);
    }

    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((query) => {
        const entryId = query.get('entryId');
        const instanceId = query.get('instanceId');
        const bundlePath = query.get('bundlePath');

        this.sourceEntryId.set(entryId);
        this.sourceInstanceId.set(instanceId);
        this.loadedBundlePath.set(bundlePath);
        void this.loadSource(entryId, instanceId, bundlePath);
      });
  }

  async loadBundleFromDisk(): Promise<void> {
    const selected = await this.fileIpc.selectFiles({
      multiple: false,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    const filePath = selected?.[0];
    if (!filePath) {
      return;
    }

    await this.router.navigate(['/replay'], {
      queryParams: { bundlePath: filePath },
    });
  }

  async saveBundle(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.info.set(null);

    try {
      const response = this.sourceEntryId()
        ? await this.shareIpc.saveForHistory(this.sourceEntryId()!)
        : await this.shareIpc.saveForInstance(this.sourceInstanceId()!);

      if (!response.success || !response.data || typeof response.data !== 'object') {
        throw new Error(response.error?.message || 'Failed to save redacted share bundle.');
      }

      const filePath = (response.data as { filePath?: string }).filePath;
      this.info.set(filePath ? `Saved share bundle to ${filePath}` : 'Saved share bundle.');
    } catch (error) {
      this.error.set((error as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  async replayBundle(): Promise<void> {
    const bundlePath = this.loadedBundlePath();
    const workingDirectory = this.replayWorkingDirectory().trim();
    if (!bundlePath || !workingDirectory) {
      return;
    }

    this.loading.set(true);
    this.error.set(null);
    this.info.set(null);

    try {
      const response = await this.shareIpc.replayBundle(bundlePath, workingDirectory);
      if (!response.success || !response.data || typeof response.data !== 'object') {
        throw new Error(response.error?.message || 'Failed to replay bundle.');
      }

      const instanceId = (response.data as { id?: string }).id;
      if (instanceId) {
        this.instanceStore.setSelectedInstance(instanceId);
      }
      await this.router.navigate(['/']);
    } catch (error) {
      this.error.set((error as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  async restoreHistory(): Promise<void> {
    const entryId = this.sourceEntryId();
    if (!entryId) {
      return;
    }

    this.loading.set(true);
    this.error.set(null);
    this.info.set(null);

    try {
      const result = await this.historyStore.restoreEntry(
        entryId,
        this.replayWorkingDirectory().trim() || undefined,
      );

      if (!result.success || !result.instanceId) {
        throw new Error(result.error || 'Failed to restore history entry.');
      }

      if (result.restoredMessages?.length) {
        this.instanceStore.setInstanceMessages(
          result.instanceId,
          result.restoredMessages as OutputMessage[],
        );
      }
      this.instanceStore.setSelectedInstance(result.instanceId);
      await this.router.navigate(['/']);
    } catch (error) {
      this.error.set((error as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  openSnapshots(): void {
    const instanceId = this.replaySourceInstanceId();
    if (!instanceId) {
      return;
    }

    void this.router.navigate(['/snapshots'], {
      queryParams: { instanceId },
    });
  }

  getInputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  formatDate(timestamp: number | undefined): string {
    if (!timestamp) {
      return 'n/a';
    }
    return new Date(timestamp).toLocaleString();
  }

  formatBytes(size: number | undefined): string {
    if (!size && size !== 0) {
      return 'n/a';
    }
    if (size < 1024) {
      return `${size} B`;
    }
    if (size < 1024 * 1024) {
      return `${(size / 1024).toFixed(1)} KB`;
    }
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  toDataUrl(attachment: SessionShareAttachment): string {
    return `data:${attachment.mediaType || 'application/octet-stream'};base64,${attachment.embeddedBase64}`;
  }

  private getTimelineTitleForMessage(message: OutputMessage): string {
    const titles: Record<string, string> = {
      user: 'User message',
      assistant: 'Assistant response',
      tool_use: 'Tool invocation',
      tool_result: 'Tool result',
      error: 'Error output',
      system: 'System message',
    };

    return titles[message.type] || message.type;
  }

  private truncateText(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
  }

  private async loadSource(
    entryId: string | null,
    instanceId: string | null,
    bundlePath: string | null,
  ): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.info.set(null);
    this.bundle.set(null);

    try {
      let response;
      if (bundlePath) {
        response = await this.shareIpc.loadBundle(bundlePath);
      } else if (entryId) {
        response = await this.shareIpc.previewForHistory(entryId);
      } else if (instanceId) {
        response = await this.shareIpc.previewForInstance(instanceId);
      } else {
        return;
      }

      if (!response.success || !response.data) {
        throw new Error(response.error?.message || 'Failed to load replay source.');
      }

      this.bundle.set(response.data as SessionShareBundle);
    } catch (error) {
      this.error.set((error as Error).message);
    } finally {
      this.loading.set(false);
    }
  }
}
