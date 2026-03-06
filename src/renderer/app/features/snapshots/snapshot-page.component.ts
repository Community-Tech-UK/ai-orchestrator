/**
 * Snapshot Page
 * File snapshot browser with diff viewing and revert operations.
 */

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { SnapshotIpcService } from '../../core/services/ipc/snapshot-ipc.service';
import { SessionShareIpcService } from '../../core/services/ipc/session-share-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import { DiffViewerComponent } from '../../shared/components/diff-viewer/diff-viewer.component';
import type { SessionShareAttachment, SessionShareBundle } from '../../../../shared/types/session-share.types';

interface SnapshotSession {
  id: string;
  instanceId: string;
  description?: string;
  startedAt: string;
  endedAt?: string;
  fileCount?: number;
}

interface SnapshotEntry {
  id: string;
  filePath: string;
  action: 'create' | 'modify' | 'delete';
  createdAt: string;
  sessionId?: string;
}

interface SnapshotStats {
  totalSnapshots: number;
  totalSessions: number;
  storageUsedBytes: number;
  oldestSnapshot?: string;
}

interface SnapshotDiff {
  oldContent: string;
  newContent: string;
  filePath: string;
}

@Component({
  selector: 'app-snapshot-page',
  standalone: true,
  imports: [CommonModule, DiffViewerComponent],
  template: `
    <div class="page">

      <!-- Page Header -->
      <div class="page-header">
        <button class="header-btn" type="button" (click)="goBack()">← Back</button>
        <div class="header-title">
          <span class="title">Snapshots</span>
          <span class="subtitle">File snapshots, diffs, and revert operations</span>
        </div>
        <div class="header-actions">
          <button class="btn" type="button" [disabled]="loading()" (click)="refresh()">
            Refresh
          </button>
          <button class="btn danger" type="button" [disabled]="loading()" (click)="runCleanup()">
            Cleanup
          </button>
        </div>
      </div>

      <!-- Error Banner -->
      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }

      <!-- Info Banner -->
      @if (infoMessage()) {
        <div class="info-banner">{{ infoMessage() }}</div>
      }

      <!-- Stats Row -->
      <div class="stats-row">
        <div class="stat-card">
          <span class="stat-label">Total Snapshots</span>
          <span class="stat-value">{{ stats()?.totalSnapshots ?? '—' }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Total Sessions</span>
          <span class="stat-value">{{ stats()?.totalSessions ?? '—' }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Storage Used</span>
          <span class="stat-value">{{ formatBytes(stats()?.storageUsedBytes) }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Oldest Snapshot</span>
          <span class="stat-value">{{ formatDate(stats()?.oldestSnapshot) }}</span>
        </div>
      </div>

      <!-- Instance ID Input -->
      <div class="instance-bar">
        <label class="field">
          <span class="field-label">Instance ID</span>
          <input
            class="input"
            type="text"
            placeholder="Enter instance ID to browse snapshots"
            [value]="selectedInstanceId()"
            (input)="onInstanceIdInput($event)"
            (keydown.enter)="loadSessions(selectedInstanceId())"
          />
        </label>
        <button
          class="btn primary"
          type="button"
          [disabled]="!selectedInstanceId().trim() || loading()"
          (click)="loadSessions(selectedInstanceId())"
        >
          Load Sessions
        </button>
        <button
          class="btn"
          type="button"
          [disabled]="!selectedInstanceId().trim()"
          (click)="openReplay()"
        >
          Open Replay & Share
        </button>
      </div>

      <!-- 3-Column Layout -->
      <div class="columns">

        <!-- Left: Sessions List -->
        <div class="panel panel-left">
          <div class="panel-header">Sessions</div>
          @if (sessions().length === 0) {
            <div class="empty-hint">
              @if (selectedInstanceId().trim()) {
                No sessions found for this instance.
              } @else {
                Enter an instance ID above to load sessions.
              }
            </div>
          } @else {
            <ul class="item-list">
              @for (session of sessions(); track session.id) {
                <li
                  class="item-row"
                  [class.selected]="selectedSessionId() === session.id"
                  (click)="selectSession(session)"
                  (keydown.enter)="selectSession(session)"
                  tabindex="0"
                  role="button"
                >
                  <div class="item-main">
                    <span class="item-name" title="{{ session.id }}">
                      {{ session.description || session.id.slice(0, 12) + '…' }}
                    </span>
                    <span class="item-badge">{{ session.fileCount ?? 0 }} files</span>
                  </div>
                  <div class="item-meta">
                    <span>{{ session.instanceId }}</span>
                    <span>{{ formatDate(session.startedAt) }}</span>
                  </div>
                </li>
              }
            </ul>
          }
        </div>

        <!-- Center: Snapshots / Files List -->
        <div class="panel panel-center">
          <div class="panel-header">
            Files
            @if (selectedSessionId()) {
              <span class="panel-header-sub">— {{ snapshots().length }} snapshot(s)</span>
            }
          </div>
          @if (!selectedSessionId()) {
            <div class="empty-hint">Select a session to view its snapshots.</div>
          } @else if (snapshots().length === 0) {
            <div class="empty-hint">No snapshots in this session.</div>
          } @else {
            <ul class="item-list">
              @for (snap of snapshots(); track snap.id) {
                <li
                  class="item-row"
                  [class.selected]="selectedSnapshotId() === snap.id"
                  (click)="selectSnapshot(snap)"
                  (keydown.enter)="selectSnapshot(snap)"
                  tabindex="0"
                  role="button"
                >
                  <div class="item-main">
                    <span class="action-icon" [class]="'action-' + snap.action" title="{{ snap.action }}">
                      {{ actionIcon(snap.action) }}
                    </span>
                    <span class="item-name item-file" title="{{ snap.filePath }}">
                      {{ shortPath(snap.filePath) }}
                    </span>
                  </div>
                  <div class="item-meta">
                    <span class="action-label">{{ snap.action }}</span>
                    <span>{{ formatDate(snap.createdAt) }}</span>
                  </div>
                </li>
              }
            </ul>
          }
        </div>

        <!-- Right: Diff Viewer -->
        <div class="panel panel-right">
          <div class="panel-header">
            Diff
            @if (currentDiff()) {
              <span class="panel-header-sub">— {{ shortPath(currentDiff()!.filePath) }}</span>
            }
          </div>
          @if (!selectedSnapshotId()) {
            <div class="empty-hint">Select a file snapshot to view its diff.</div>
          } @else if (loadingDiff()) {
            <div class="empty-hint">Loading diff…</div>
          } @else if (currentDiff()) {
            <app-diff-viewer
              [oldContent]="currentDiff()!.oldContent"
              [newContent]="currentDiff()!.newContent"
              [fileName]="shortPath(currentDiff()!.filePath)"
              [interactive]="true"
            />
          } @else {
            <div class="empty-hint">No diff available for this snapshot.</div>
          }
        </div>

      </div>

      <div class="columns evidence-columns">
        <div class="panel panel-left">
          <div class="panel-header">
            Evidence & Review Artifacts
            <span class="panel-header-sub">— {{ evidenceBundle()?.artifacts?.length || 0 }}</span>
          </div>

          @if (loadingEvidence()) {
            <div class="empty-hint">Loading evidence preview…</div>
          } @else if (!selectedInstanceId().trim()) {
            <div class="empty-hint">Enter an instance ID to inspect replay artifacts for that run.</div>
          } @else if (!evidenceBundle()?.artifacts?.length) {
            <div class="empty-hint">No structured review artifacts were recorded for this instance.</div>
          } @else {
            <ul class="item-list">
              @for (artifact of evidenceBundle()!.artifacts; track artifact.id) {
                <li class="item-row evidence-row">
                  <div class="item-main">
                    <span class="item-badge">{{ artifact.type }}</span>
                    <span class="item-name" title="{{ artifact.title }}">{{ artifact.title }}</span>
                  </div>
                  @if (artifact.fileLabel) {
                    <div class="item-meta">
                      <span>{{ artifact.fileLabel }}</span>
                      <span>{{ formatDate(artifact.timestamp) }}</span>
                    </div>
                  } @else {
                    <div class="item-meta">
                      <span>{{ formatDate(artifact.timestamp) }}</span>
                    </div>
                  }
                  <pre class="evidence-preview">{{ artifact.content }}</pre>
                </li>
              }
            </ul>
          }
        </div>

        <div class="panel panel-center">
          <div class="panel-header">
            Embedded Attachments
            <span class="panel-header-sub">— {{ evidenceBundle()?.attachments?.length || 0 }}</span>
          </div>

          @if (loadingEvidence()) {
            <div class="empty-hint">Loading attachments…</div>
          } @else if (!evidenceBundle()?.attachments?.length) {
            <div class="empty-hint">No embedded evidence files were included in the share preview.</div>
          } @else {
            <ul class="item-list">
              @for (attachment of evidenceBundle()!.attachments; track attachment.id) {
                <li class="item-row evidence-row">
                  <div class="item-main">
                    <span class="item-badge">{{ attachment.kind }}</span>
                    <span class="item-name" title="{{ attachment.title }}">{{ attachment.title }}</span>
                  </div>
                  <div class="item-meta">
                    <span>{{ attachment.sourcePathLabel || attachment.fileName || 'Attachment' }}</span>
                    <span>{{ formatAttachmentMeta(attachment) }}</span>
                  </div>
                  @if (attachment.embeddedBase64 && attachment.mediaType?.startsWith('image/')) {
                    <img class="attachment-image" [src]="toDataUrl(attachment)" [alt]="attachment.title" />
                  } @else if (attachment.embeddedText) {
                    <pre class="evidence-preview">{{ attachment.embeddedText }}</pre>
                  }
                </li>
              }
            </ul>
          }
        </div>

        <div class="panel panel-right">
          <div class="panel-header">
            Replay Summary
            <span class="panel-header-sub">
              — {{ evidenceBundle()?.summary?.continuitySnapshotCount || 0 }} continuity /
              {{ evidenceBundle()?.summary?.fileSnapshotSessionCount || 0 }} file sessions
            </span>
          </div>

          @if (!evidenceBundle()) {
            <div class="empty-hint">Load an instance to inspect its replay summary and redaction warnings.</div>
          } @else {
            <div class="evidence-summary">
              <div class="summary-card">
                <span class="field-label">Messages</span>
                <strong>{{ evidenceBundle()!.summary.totalMessages }}</strong>
              </div>
              <div class="summary-card">
                <span class="field-label">Artifacts</span>
                <strong>{{ evidenceBundle()!.summary.artifactCount }}</strong>
              </div>
              <div class="summary-card">
                <span class="field-label">Attachments</span>
                <strong>{{ evidenceBundle()!.summary.attachmentCount }}</strong>
              </div>
              <div class="summary-card">
                <span class="field-label">Redactions</span>
                <strong>{{ evidenceBundle()!.summary.redactedContentCount }}</strong>
              </div>
            </div>

            @if (evidenceBundle()!.warnings.length) {
              <ul class="warning-list">
                @for (warning of evidenceBundle()!.warnings; track warning) {
                  <li>{{ warning }}</li>
                }
              </ul>
            } @else {
              <div class="empty-hint">No redaction or artifact warnings were reported for this replay preview.</div>
            }
          }
        </div>
      </div>

      <!-- Confirmation Overlay -->
      @if (confirmRevert()) {
        <div class="confirm-overlay">
          <div class="confirm-dialog">
            <p class="confirm-title">Are you sure?</p>
            @if (confirmRevert() === 'file') {
              <p class="confirm-body">
                This will revert <strong>{{ shortPath(selectedSnapshot()?.filePath ?? '') }}</strong>
                to its snapshot state. This cannot be undone.
              </p>
            } @else {
              <p class="confirm-body">
                This will revert <strong>all files</strong> in the selected session
                to their snapshot states. This cannot be undone.
              </p>
            }
            <div class="confirm-actions">
              <button class="btn danger" type="button" [disabled]="loading()" (click)="executeRevert()">
                Confirm Revert
              </button>
              <button class="btn" type="button" (click)="confirmRevert.set(null)">
                Cancel
              </button>
            </div>
          </div>
        </div>
      }

      <!-- Bottom Action Bar -->
      <div class="action-bar">
        <button
          class="btn primary"
          type="button"
          [disabled]="!canRevertFile() || loading()"
          (click)="confirmRevert.set('file')"
        >
          Revert File
        </button>
        <button
          class="btn"
          type="button"
          [disabled]="!canRevertSession() || loading()"
          (click)="confirmRevert.set('session')"
        >
          Revert Session
        </button>
        <button
          class="btn danger"
          type="button"
          [disabled]="!selectedSnapshotId() || loading()"
          (click)="deleteSnapshot()"
        >
          Delete Snapshot
        </button>
      </div>

    </div>
  `,
  styles: [`
    :host {
      display: flex;
      width: 100%;
      height: 100%;
    }

    .page {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
      padding: var(--spacing-lg);
      background: var(--bg-primary);
      color: var(--text-primary);
      overflow: hidden;
      position: relative;
    }

    /* ---- Header ---- */

    .page-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      flex-shrink: 0;
    }

    .header-btn {
      padding: var(--spacing-xs) var(--spacing-md);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      cursor: pointer;
      font-size: 12px;
      white-space: nowrap;
    }

    .header-title {
      display: flex;
      flex-direction: column;
      flex: 1;
    }

    .title {
      font-size: 18px;
      font-weight: 700;
    }

    .subtitle {
      font-size: 12px;
      color: var(--text-muted);
    }

    .header-actions {
      display: flex;
      gap: var(--spacing-xs);
    }

    /* ---- Banners ---- */

    .error-banner {
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: var(--radius-sm);
      border: 1px solid color-mix(in srgb, var(--error-color) 60%, transparent);
      background: color-mix(in srgb, var(--error-color) 14%, transparent);
      color: var(--error-color);
      font-size: 12px;
      flex-shrink: 0;
    }

    .info-banner {
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: var(--radius-sm);
      border: 1px solid color-mix(in srgb, var(--success-color) 50%, transparent);
      background: color-mix(in srgb, var(--success-color) 12%, transparent);
      color: var(--success-color);
      font-size: 12px;
      flex-shrink: 0;
    }

    /* ---- Stats Row ---- */

    .stats-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--spacing-sm);
      flex-shrink: 0;
    }

    .stat-card {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: var(--spacing-sm) var(--spacing-md);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
    }

    .stat-label {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .stat-value {
      font-size: 20px;
      font-weight: 700;
      color: var(--primary-color);
    }

    /* ---- Instance Bar ---- */

    .instance-bar {
      display: flex;
      align-items: flex-end;
      gap: var(--spacing-sm);
      flex-shrink: 0;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      flex: 1;
    }

    .field-label {
      font-size: 12px;
      color: var(--text-muted);
    }

    .input {
      width: 100%;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-secondary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
    }

    .input:focus {
      outline: none;
      border-color: var(--primary-color);
    }

    /* ---- Buttons ---- */

    .btn {
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }

    .btn.primary {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: #000;
      font-weight: 600;
    }

    .btn.danger {
      border-color: color-mix(in srgb, var(--error-color) 60%, transparent);
      color: var(--error-color);
    }

    .btn.danger:hover:not(:disabled) {
      background: color-mix(in srgb, var(--error-color) 20%, transparent);
    }

    .btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    /* ---- 3-Column Layout ---- */

    .columns {
      flex: 1;
      min-height: 0;
      display: grid;
      grid-template-columns: 280px 300px 1fr;
      gap: var(--spacing-md);
    }

    .panel {
      display: flex;
      flex-direction: column;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      overflow: hidden;
      min-height: 0;
    }

    .panel-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      padding: var(--spacing-xs) var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      flex-shrink: 0;
    }

    .panel-header-sub {
      font-weight: 400;
      text-transform: none;
      letter-spacing: 0;
      color: var(--text-secondary);
    }

    .panel-right {
      overflow: auto;
    }

    .evidence-columns {
      flex: 0 0 auto;
      min-height: 18rem;
    }

    /* ---- Item Lists ---- */

    .item-list {
      list-style: none;
      margin: 0;
      padding: 0;
      overflow-y: auto;
      flex: 1;
    }

    .item-row {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: var(--spacing-xs) var(--spacing-md);
      cursor: pointer;
      border-bottom: 1px solid var(--border-color);
      transition: background 0.1s;
    }

    .item-row:hover {
      background: var(--bg-tertiary);
    }

    .item-row.selected {
      background: color-mix(in srgb, var(--primary-color) 12%, transparent);
      border-left: 3px solid var(--primary-color);
      padding-left: calc(var(--spacing-md) - 3px);
    }

    .item-main {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      min-width: 0;
    }

    .item-name {
      font-size: 12px;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
    }

    .item-file {
      font-family: monospace;
      font-size: 11px;
    }

    .item-badge {
      font-size: 10px;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      padding: 1px 5px;
      color: var(--text-muted);
      white-space: nowrap;
    }

    .item-meta {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      color: var(--text-muted);
    }

    /* ---- Action Icons ---- */

    .action-icon {
      font-size: 11px;
      font-weight: 700;
      width: 16px;
      text-align: center;
      flex-shrink: 0;
    }

    .action-create { color: var(--success-color); }
    .action-modify { color: var(--primary-color); }
    .action-delete { color: var(--error-color); }

    .action-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    /* ---- Empty State ---- */

    .empty-hint {
      padding: var(--spacing-md);
      font-size: 12px;
      color: var(--text-muted);
      text-align: center;
      margin-top: var(--spacing-md);
    }

    .evidence-row {
      gap: var(--spacing-xs);
      cursor: default;
    }

    .evidence-preview {
      margin: 0;
      font-family: var(--font-mono);
      font-size: 11px;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--text-secondary);
    }

    .attachment-image {
      width: 100%;
      max-height: 18rem;
      object-fit: contain;
      border-radius: var(--radius-sm);
      background: var(--bg-primary);
    }

    .evidence-summary {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--spacing-sm);
      padding: var(--spacing-md);
    }

    .summary-card {
      display: grid;
      gap: 0.25rem;
      padding: var(--spacing-sm);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-primary);
    }

    .summary-card strong {
      font-size: 1rem;
      color: var(--primary-color);
    }

    .warning-list {
      margin: 0;
      padding: 0 var(--spacing-lg) var(--spacing-md) 1.5rem;
      color: #fbbf24;
      display: grid;
      gap: 0.35rem;
    }

    /* ---- Confirmation Overlay ---- */

    .confirm-overlay {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10;
    }

    .confirm-dialog {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      padding: var(--spacing-lg);
      max-width: 420px;
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
    }

    .confirm-title {
      margin: 0;
      font-size: 16px;
      font-weight: 700;
      color: var(--text-primary);
    }

    .confirm-body {
      margin: 0;
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.6;
    }

    .confirm-actions {
      display: flex;
      gap: var(--spacing-sm);
      justify-content: flex-end;
    }

    /* ---- Action Bar ---- */

    .action-bar {
      display: flex;
      gap: var(--spacing-sm);
      align-items: center;
      padding: var(--spacing-sm) var(--spacing-md);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      flex-shrink: 0;
    }

    /* ---- Responsive ---- */

    @media (max-width: 1100px) {
      .columns {
        grid-template-columns: 1fr 1fr;
      }

      .panel-right {
        grid-column: span 2;
      }

      .stats-row {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    @media (max-width: 700px) {
      .columns {
        grid-template-columns: 1fr;
      }

      .panel-right {
        grid-column: span 1;
      }

      .stats-row {
        grid-template-columns: repeat(2, 1fr);
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SnapshotPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly snapshotIpc = inject(SnapshotIpcService);
  private readonly sessionShareIpc = inject(SessionShareIpcService);

  // ---- State signals ----

  readonly sessions = signal<SnapshotSession[]>([]);
  readonly snapshots = signal<SnapshotEntry[]>([]);

  readonly selectedInstanceId = signal('');
  readonly selectedSessionId = signal<string | null>(null);
  readonly selectedSnapshotId = signal<string | null>(null);

  readonly stats = signal<SnapshotStats | null>(null);
  readonly currentDiff = signal<SnapshotDiff | null>(null);
  readonly evidenceBundle = signal<SessionShareBundle | null>(null);

  readonly loading = signal(false);
  readonly loadingDiff = signal(false);
  readonly loadingEvidence = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly infoMessage = signal<string | null>(null);

  /** Set to 'file' or 'session' when awaiting user confirmation. */
  readonly confirmRevert = signal<'file' | 'session' | null>(null);

  // ---- Derived ----

  readonly selectedSession = computed(() =>
    this.sessions().find((s) => s.id === this.selectedSessionId()) ?? null
  );

  readonly selectedSnapshot = computed(() =>
    this.snapshots().find((s) => s.id === this.selectedSnapshotId()) ?? null
  );

  readonly canRevertFile = computed(
    () => this.selectedSnapshotId() !== null
  );

  readonly canRevertSession = computed(
    () => this.selectedSessionId() !== null
  );

  constructor() {
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((query) => {
        const instanceId = query.get('instanceId')?.trim() || '';
        if (!instanceId || instanceId === this.selectedInstanceId().trim()) {
          return;
        }

        this.selectedInstanceId.set(instanceId);
        void this.loadSessions(instanceId);
      });
  }

  // ---- Lifecycle ----

  async ngOnInit(): Promise<void> {
    await this.loadStats();
  }

  ngOnDestroy(): void {
    this.confirmRevert.set(null);
  }

  // ---- Navigation ----

  goBack(): void {
    this.router.navigate(['/']);
  }

  // ---- Public event handlers ----

  onInstanceIdInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.selectedInstanceId.set(target.value);
  }

  openReplay(): void {
    const instanceId = this.selectedInstanceId().trim();
    if (!instanceId) {
      return;
    }

    void this.router.navigate(['/replay'], {
      queryParams: { instanceId },
    });
  }

  async refresh(): Promise<void> {
    this.clearMessages();
    await this.loadStats();
    const instanceId = this.selectedInstanceId().trim();
    if (instanceId) {
      await this.loadSessions(instanceId);
    }
  }

  async loadSessions(instanceId: string): Promise<void> {
    if (!instanceId.trim()) return;
    this.clearMessages();
    this.loading.set(true);
    this.loadingEvidence.set(true);
    this.sessions.set([]);
    this.snapshots.set([]);
    this.selectedSessionId.set(null);
    this.selectedSnapshotId.set(null);
    this.currentDiff.set(null);
    this.evidenceBundle.set(null);

    try {
      const response = await this.snapshotIpc.snapshotGetSessions(instanceId.trim());
      const data = this.unwrapData<SnapshotSession[]>(response, []);
      this.sessions.set(data);
      await this.loadEvidence(instanceId.trim());
    } finally {
      this.loading.set(false);
      if (this.loadingEvidence() && !this.evidenceBundle()) {
        this.loadingEvidence.set(false);
      }
    }
  }

  async selectSession(session: SnapshotSession): Promise<void> {
    if (this.selectedSessionId() === session.id) return;
    this.clearMessages();
    this.selectedSessionId.set(session.id);
    this.selectedSnapshotId.set(null);
    this.currentDiff.set(null);
    this.snapshots.set([]);
    await this.loadSnapshots(session.id);
  }

  async selectSnapshot(snapshot: SnapshotEntry): Promise<void> {
    if (this.selectedSnapshotId() === snapshot.id) return;
    this.clearMessages();
    this.selectedSnapshotId.set(snapshot.id);
    this.currentDiff.set(null);
    await this.loadDiff(snapshot.id);
  }

  async runCleanup(): Promise<void> {
    this.clearMessages();
    this.loading.set(true);
    try {
      const response = await this.snapshotIpc.snapshotCleanup();
      if (response.success) {
        this.infoMessage.set('Cleanup completed successfully.');
        await this.loadStats();
      } else {
        this.errorMessage.set(response.error?.message ?? 'Cleanup failed.');
      }
    } finally {
      this.loading.set(false);
    }
  }

  async deleteSnapshot(): Promise<void> {
    const id = this.selectedSnapshotId();
    if (!id) return;
    this.clearMessages();
    this.loading.set(true);
    try {
      const response = await this.snapshotIpc.snapshotDelete(id);
      if (response.success) {
        this.infoMessage.set('Snapshot deleted.');
        this.selectedSnapshotId.set(null);
        this.currentDiff.set(null);
        this.snapshots.update((list) => list.filter((s) => s.id !== id));
        await this.loadStats();
      } else {
        this.errorMessage.set(response.error?.message ?? 'Delete failed.');
      }
    } finally {
      this.loading.set(false);
    }
  }

  async executeRevert(): Promise<void> {
    const mode = this.confirmRevert();
    if (!mode) return;

    this.confirmRevert.set(null);
    this.clearMessages();
    this.loading.set(true);

    try {
      if (mode === 'file') {
        const snapshotId = this.selectedSnapshotId();
        if (!snapshotId) return;
        const response = await this.snapshotIpc.snapshotRevertFile(snapshotId);
        if (response.success) {
          this.infoMessage.set('File reverted successfully.');
        } else {
          this.errorMessage.set(response.error?.message ?? 'Revert failed.');
        }
      } else {
        const sessionId = this.selectedSessionId();
        if (!sessionId) return;
        const response = await this.snapshotIpc.snapshotRevertSession(sessionId);
        if (response.success) {
          this.infoMessage.set('Session reverted successfully.');
        } else {
          this.errorMessage.set(response.error?.message ?? 'Session revert failed.');
        }
      }
    } finally {
      this.loading.set(false);
    }
  }

  // ---- Display helpers ----

  actionIcon(action: 'create' | 'modify' | 'delete'): string {
    switch (action) {
      case 'create': return '+';
      case 'modify': return '~';
      case 'delete': return '−';
    }
  }

  shortPath(filePath: string): string {
    if (!filePath) return '';
    const parts = filePath.replace(/\\/g, '/').split('/');
    return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : filePath;
  }

  formatBytes(bytes?: number): string {
    if (bytes == null) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  formatDate(dateValue?: string | number): string {
    if (dateValue == null || dateValue === '') return '—';
    try {
      const normalized =
        typeof dateValue === 'string' && /^\d+$/.test(dateValue)
          ? Number(dateValue)
          : dateValue;
      return new Date(normalized).toLocaleString(undefined, {
        dateStyle: 'short',
        timeStyle: 'short',
      });
    } catch {
      return String(dateValue);
    }
  }

  formatAttachmentMeta(attachment: SessionShareAttachment): string {
    const parts: string[] = [];
    if (attachment.size != null) {
      parts.push(this.formatBytes(attachment.size));
    }
    if (attachment.timestamp) {
      parts.push(this.formatDate(attachment.timestamp));
    }
    return parts.join(' · ') || 'Attachment';
  }

  toDataUrl(attachment: SessionShareAttachment): string {
    return `data:${attachment.mediaType || 'application/octet-stream'};base64,${attachment.embeddedBase64}`;
  }

  // ---- Private helpers ----

  private async loadStats(): Promise<void> {
    const response = await this.snapshotIpc.snapshotGetStats();
    const data = this.unwrapData<SnapshotStats>(response, {
      totalSnapshots: 0,
      totalSessions: 0,
      storageUsedBytes: 0,
    });
    this.stats.set(data);
  }

  private async loadSnapshots(sessionId: string): Promise<void> {
    this.loading.set(true);
    try {
      const response = await this.snapshotIpc.snapshotGetForInstance(
        this.selectedInstanceId().trim()
      );
      const all = this.unwrapData<SnapshotEntry[]>(response, []);
      const filtered = all.filter((s) => s.sessionId === sessionId);
      this.snapshots.set(filtered);
    } finally {
      this.loading.set(false);
    }
  }

  private async loadDiff(snapshotId: string): Promise<void> {
    this.loadingDiff.set(true);
    try {
      const response = await this.snapshotIpc.snapshotGetDiff(snapshotId);
      if (response.success && response.data) {
        const raw = response.data as Record<string, unknown>;
        this.currentDiff.set({
          oldContent: String(raw['oldContent'] ?? ''),
          newContent: String(raw['newContent'] ?? ''),
          filePath: String(raw['filePath'] ?? ''),
        });
      } else {
        // Fallback: try to load raw content if diff not available
        const contentResponse = await this.snapshotIpc.snapshotGetContent(snapshotId);
        if (contentResponse.success && contentResponse.data) {
          const raw = contentResponse.data as Record<string, unknown>;
          const snap = this.selectedSnapshot();
          this.currentDiff.set({
            oldContent: String(raw['content'] ?? ''),
            newContent: '',
            filePath: snap?.filePath ?? '',
          });
        } else {
          this.currentDiff.set(null);
        }
      }
    } finally {
      this.loadingDiff.set(false);
    }
  }

  private clearMessages(): void {
    this.errorMessage.set(null);
    this.infoMessage.set(null);
  }

  private async loadEvidence(instanceId: string): Promise<void> {
    this.loadingEvidence.set(true);

    try {
      const response = await this.sessionShareIpc.previewForInstance(instanceId);
      if (!response.success || !response.data) {
        this.evidenceBundle.set(null);
        return;
      }

      this.evidenceBundle.set(response.data as SessionShareBundle);
    } catch {
      this.evidenceBundle.set(null);
    } finally {
      this.loadingEvidence.set(false);
    }
  }

  private unwrapData<T>(response: IpcResponse, fallback: T): T {
    return response.success ? ((response.data as T) ?? fallback) : fallback;
  }
}
