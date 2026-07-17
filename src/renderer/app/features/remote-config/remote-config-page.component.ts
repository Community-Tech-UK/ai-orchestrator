/**
 * Remote Config Page
 * Displays remote configuration sources, fetch status, config preview,
 * source configuration form, and a live event log.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  inject,
  signal,
  computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RemoteConfigIpcService } from '../../core/services/ipc/remote-config-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';

interface ConfigStatus {
  connected: boolean;
  lastFetched?: number;
  source?: {
    type: string;
    location?: string;
  };
  cacheAge?: number;
}

interface EventLogEntry {
  id: number;
  kind: 'update' | 'error';
  timestamp: number;
  summary: string;
}

type SourceType = 'url' | 'file' | 'git';

let eventLogIdCounter = 0;

@Component({
  selector: 'app-remote-config-page',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="page">

      <!-- Page Header -->
      <div class="page-header">
        <div class="header-title">
          <span class="title">Remote Config</span>
          <span class="subtitle">Remote configuration sources and caching</span>
        </div>
        <div class="header-actions">
          <button class="btn" type="button" [disabled]="working()" (click)="refreshAll()">
            Refresh
          </button>
        </div>
      </div>

      <!-- Error / Info Banners -->
      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }
      @if (infoMessage()) {
        <div class="info-banner">{{ infoMessage() }}</div>
      }

      <div class="content">

        <!-- Left column: status + form -->
        <div class="main-panel">

          <!-- Status Card -->
          <div class="panel-card">
            <div class="panel-title">Connection Status</div>
            <div class="status-row">
              <span
                class="status-badge"
                [class.connected]="status()?.connected"
                [class.disconnected]="!status()?.connected"
              >
                {{ status()?.connected ? 'Connected' : 'Disconnected' }}
              </span>
              @if (status()?.source?.type) {
                <span class="status-meta">
                  Source type: {{ status()!.source!.type }}
                </span>
              }
              @if (status()?.source?.location) {
                <span class="status-meta truncate">
                  {{ status()!.source!.location }}
                </span>
              }
            </div>

            @if (status()?.lastFetched) {
              <div class="meta-row">
                <span class="meta-label">Last fetched:</span>
                <span class="meta-value">{{ formatDate(status()!.lastFetched!) }}</span>
              </div>
            }
            @if (status()?.cacheAge !== undefined) {
              <div class="meta-row">
                <span class="meta-label">Cache age:</span>
                <span class="meta-value">{{ formatAge(status()!.cacheAge!) }}</span>
              </div>
            }

            <div class="row-actions">
              <button class="btn primary" type="button" [disabled]="working()" (click)="fetchNow()">
                Fetch Now
              </button>
            </div>
          </div>

          <!-- Source Config Form -->
          <div class="panel-card">
            <div class="panel-title">Configure Source</div>

            <label class="field">
              <span class="label">Source Type</span>
              <select class="select" [value]="sourceType()" (change)="onSourceTypeChange($event)">
                <option value="url">URL</option>
                <option value="file">File</option>
                <option value="git">Git</option>
              </select>
            </label>

            <label class="field">
              <span class="label">
                @if (sourceType() === 'url') { URL }
                @else if (sourceType() === 'file') { File Path }
                @else { Repository URL }
              </span>
              <input
                class="input"
                type="text"
                [value]="sourceLocation()"
                (input)="onLocationInput($event)"
                [placeholder]="locationPlaceholder()"
              />
            </label>

            @if (sourceType() === 'git') {
              <label class="field">
                <span class="label">Branch (optional)</span>
                <input
                  class="input"
                  type="text"
                  [value]="sourceBranch()"
                  (input)="onBranchInput($event)"
                  placeholder="main"
                />
              </label>
            }

            <label class="field">
              <span class="label">Refresh Interval (seconds, 0 = manual)</span>
              <input
                class="input"
                type="number"
                min="0"
                [value]="refreshInterval()"
                (input)="onRefreshIntervalInput($event)"
              />
            </label>

            <div class="row-actions">
              <button
                class="btn primary"
                type="button"
                [disabled]="working() || !sourceLocation().trim()"
                (click)="saveSource()"
              >
                Save Source
              </button>
            </div>
          </div>

        </div>

        <!-- Right column: config preview + event log -->
        <div class="side-panel">

          <!-- Config Preview -->
          <div class="panel-card preview-card">
            <div class="panel-header-row">
              <div class="panel-title">Config Preview</div>
              <button class="btn tiny" type="button" (click)="togglePreview()">
                {{ previewCollapsed() ? 'Expand' : 'Collapse' }}
              </button>
            </div>

            @if (!previewCollapsed()) {
              @if (configPreviewJson()) {
                <pre class="json-preview">{{ configPreviewJson() }}</pre>
              } @else {
                <div class="hint">No config loaded. Fetch to populate.</div>
              }
            } @else {
              <div class="hint">Preview collapsed.</div>
            }
          </div>

          <!-- Event Log -->
          <div class="panel-card event-log-card">
            <div class="panel-header-row">
              <div class="panel-title">Event Log</div>
              <button class="btn tiny" type="button" (click)="clearEventLog()">Clear</button>
            </div>

            @if (eventLog().length === 0) {
              <div class="hint">No events yet. Events appear when config updates or errors occur.</div>
            } @else {
              <div class="event-list">
                @for (entry of eventLog(); track entry.id) {
                  <div class="event-entry" [class.event-error]="entry.kind === 'error'">
                    <span class="event-kind">{{ entry.kind === 'update' ? 'UPDATE' : 'ERROR' }}</span>
                    <span class="event-time">{{ formatDate(entry.timestamp) }}</span>
                    <span class="event-summary">{{ entry.summary }}</span>
                  </div>
                }
              </div>
            }
          </div>

        </div>
      </div>
    </div>
  `,
  styles: [
    `
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
        overflow: auto;
      }

      .page-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        flex-shrink: 0;
      }

      .header-title {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
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

      .btn {
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: 12px;
        cursor: pointer;
      }

      .btn.primary {
        background: var(--primary-color);
        border-color: var(--primary-color);
        color: #fff;
      }

      .btn.tiny {
        padding: 2px 8px;
        font-size: 11px;
      }

      .btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .error-banner,
      .info-banner {
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-sm);
        font-size: 12px;
        flex-shrink: 0;
      }

      .error-banner {
        border: 1px solid color-mix(in srgb, var(--error-color) 60%, transparent);
        background: color-mix(in srgb, var(--error-color) 14%, transparent);
        color: var(--error-color);
      }

      .info-banner {
        border: 1px solid color-mix(in srgb, var(--primary-color) 60%, transparent);
        background: color-mix(in srgb, var(--primary-color) 12%, transparent);
        color: var(--text-primary);
      }

      .content {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(300px, 1fr);
        gap: var(--spacing-md);
        align-items: start;
      }

      .main-panel {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
      }

      .side-panel {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
      }

      .panel-card {
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        padding: var(--spacing-md);
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .panel-title {
        font-size: 12px;
        font-weight: 700;
        color: var(--text-muted);
      }

      .panel-header-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-xs);
      }

      /* Status */
      .status-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        flex-wrap: wrap;
      }

      .status-badge {
        font-size: 11px;
        font-weight: 700;
        padding: 2px 8px;
        border-radius: var(--radius-sm);
      }

      .status-badge.connected {
        background: color-mix(in srgb, var(--success-color) 20%, transparent);
        color: var(--success-color);
        border: 1px solid color-mix(in srgb, var(--success-color) 40%, transparent);
      }

      .status-badge.disconnected {
        background: color-mix(in srgb, var(--warning-color) 20%, transparent);
        color: var(--warning-color);
        border: 1px solid color-mix(in srgb, var(--warning-color) 40%, transparent);
      }

      .status-meta {
        font-size: 12px;
        color: var(--text-secondary);
      }

      .status-meta.truncate {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 240px;
      }

      .meta-row {
        display: flex;
        gap: var(--spacing-xs);
        align-items: baseline;
        font-size: 12px;
      }

      .meta-label {
        color: var(--text-muted);
        flex-shrink: 0;
      }

      .meta-value {
        color: var(--text-secondary);
        word-break: break-all;
      }

      .row-actions {
        display: flex;
        gap: var(--spacing-xs);
        flex-wrap: wrap;
      }

      /* Form */
      .field {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .label {
        font-size: 11px;
        color: var(--text-muted);
      }

      .input,
      .select {
        width: 100%;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        background: var(--bg-primary);
        color: var(--text-primary);
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: 12px;
      }

      /* Config preview */
      .preview-card {
        overflow: hidden;
      }

      .json-preview {
        margin: 0;
        padding: var(--spacing-sm);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        white-space: pre-wrap;
        word-break: break-all;
        max-height: 320px;
        overflow: auto;
        font-size: 11px;
        font-family: var(--font-family-mono);
      }

      /* Event log */
      .event-log-card {
        max-height: 320px;
        overflow: hidden;
      }

      .event-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
        overflow-y: auto;
        max-height: 240px;
      }

      .event-entry {
        display: grid;
        grid-template-columns: auto auto 1fr;
        gap: var(--spacing-xs);
        align-items: baseline;
        padding: 4px var(--spacing-xs);
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        font-size: 11px;
      }

      .event-entry.event-error {
        border-color: color-mix(in srgb, var(--error-color) 40%, transparent);
        background: color-mix(in srgb, var(--error-color) 8%, transparent);
      }

      .event-kind {
        font-weight: 700;
        letter-spacing: 0.04em;
        font-size: 10px;
        color: var(--primary-color);
      }

      .event-entry.event-error .event-kind {
        color: var(--error-color);
      }

      .event-time {
        color: var(--text-muted);
        white-space: nowrap;
      }

      .event-summary {
        color: var(--text-secondary);
        overflow-wrap: anywhere;
      }

      .hint {
        font-size: 12px;
        color: var(--text-muted);
      }

      @media (max-width: 900px) {
        .content {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemoteConfigPageComponent implements OnInit, OnDestroy {
  private readonly remoteConfigIpc = inject(RemoteConfigIpcService);

  // State signals
  readonly status = signal<ConfigStatus | null>(null);
  readonly configPreviewJson = signal<string>('');
  readonly eventLog = signal<EventLogEntry[]>([]);
  readonly previewCollapsed = signal(false);

  // Form signals
  readonly sourceType = signal<SourceType>('url');
  readonly sourceLocation = signal('');
  readonly sourceBranch = signal('');
  readonly refreshInterval = signal(0);

  // UI state
  readonly working = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly infoMessage = signal<string | null>(null);

  readonly locationPlaceholder = computed(() => {
    switch (this.sourceType()) {
      case 'url': return 'https://example.com/config.json';
      case 'file': return '/path/to/config.json';
      case 'git': return 'https://github.com/org/repo.git';
    }
  });

  // Event unsubscribe handles
  private unsubscribeUpdated: (() => void) | null = null;
  private unsubscribeError: (() => void) | null = null;

  async ngOnInit(): Promise<void> {
    this.subscribeToEvents();
    await this.refreshAll();
  }

  ngOnDestroy(): void {
    this.unsubscribeUpdated?.();
    this.unsubscribeError?.();
  }

  async refreshAll(): Promise<void> {
    this.working.set(true);
    this.errorMessage.set(null);
    this.infoMessage.set(null);

    try {
      await Promise.all([this.loadStatus(), this.loadConfigPreview()]);
    } finally {
      this.working.set(false);
    }
  }

  async fetchNow(): Promise<void> {
    this.working.set(true);
    this.errorMessage.set(null);
    this.infoMessage.set(null);

    try {
      const response = await this.remoteConfigIpc.remoteConfigFetch(true);
      this.assertSuccess(response, 'Failed to fetch remote config.');
      this.infoMessage.set('Config fetched successfully.');
      await Promise.all([this.loadStatus(), this.loadConfigPreview()]);
    } catch (error) {
      this.errorMessage.set((error as Error).message);
    } finally {
      this.working.set(false);
    }
  }

  async saveSource(): Promise<void> {
    const location = this.sourceLocation().trim();
    if (!location) {
      this.errorMessage.set('Please provide a source location.');
      return;
    }

    this.working.set(true);
    this.errorMessage.set(null);
    this.infoMessage.set(null);

    try {
      const source: {
        type: SourceType;
        location: string;
        refreshInterval?: number;
        branch?: string;
      } = {
        type: this.sourceType(),
        location,
        refreshInterval: this.refreshInterval() > 0 ? this.refreshInterval() : undefined,
      };

      if (this.sourceType() === 'git' && this.sourceBranch().trim()) {
        source.branch = this.sourceBranch().trim();
      }

      const response = await this.remoteConfigIpc.remoteConfigSetSource(source);
      this.assertSuccess(response, 'Failed to save config source.');
      this.infoMessage.set('Config source saved.');
      await Promise.all([this.loadStatus(), this.loadConfigPreview()]);
    } catch (error) {
      this.errorMessage.set((error as Error).message);
    } finally {
      this.working.set(false);
    }
  }

  togglePreview(): void {
    this.previewCollapsed.update((v) => !v);
  }

  clearEventLog(): void {
    this.eventLog.set([]);
  }

  // Form event handlers
  onSourceTypeChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.sourceType.set(target.value as SourceType);
  }

  onLocationInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.sourceLocation.set(target.value);
  }

  onBranchInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.sourceBranch.set(target.value);
  }

  onRefreshIntervalInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    const parsed = parseInt(target.value, 10);
    this.refreshInterval.set(isNaN(parsed) ? 0 : Math.max(0, parsed));
  }

  // Formatting helpers
  formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  formatAge(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }

  // Private helpers

  private subscribeToEvents(): void {
    this.unsubscribeUpdated = this.remoteConfigIpc.onRemoteConfigUpdated((data) => {
      this.addEventLogEntry('update', this.summarizePayload(data));
      void this.loadConfigPreview();
    });

    this.unsubscribeError = this.remoteConfigIpc.onRemoteConfigError((data) => {
      this.addEventLogEntry('error', this.summarizePayload(data));
    });
  }

  private async loadStatus(): Promise<void> {
    const response = await this.remoteConfigIpc.remoteConfigStatus();
    if (!response.success) {
      // Not fatal - status may not be available in all environments
      return;
    }
    const raw = response.data as Record<string, unknown> | null | undefined;
    if (raw && typeof raw === 'object') {
      this.status.set(this.parseStatus(raw));
    }
  }

  private async loadConfigPreview(): Promise<void> {
    // Retrieve the entire config by fetching an empty-string key fallback;
    // the server returns the full config when given an empty or wildcard key.
    const response = await this.remoteConfigIpc.remoteConfigGet('');
    if (!response.success || response.data === undefined || response.data === null) {
      return;
    }

    try {
      this.configPreviewJson.set(JSON.stringify(response.data, null, 2));
    } catch {
      this.configPreviewJson.set(String(response.data));
    }
  }

  private parseStatus(raw: Record<string, unknown>): ConfigStatus {
    const status: ConfigStatus = {
      connected: Boolean(raw['connected']),
    };

    if (typeof raw['lastFetched'] === 'number') {
      status.lastFetched = raw['lastFetched'];
    }

    if (typeof raw['cacheAge'] === 'number') {
      status.cacheAge = raw['cacheAge'];
    }

    const src = raw['source'];
    if (src && typeof src === 'object') {
      const srcRec = src as Record<string, unknown>;
      status.source = {
        type: String(srcRec['type'] ?? 'unknown'),
        location: typeof srcRec['location'] === 'string' ? srcRec['location'] : undefined,
      };

      // Pre-populate the form fields from the current source
      const type = String(srcRec['type'] ?? 'url');
      if (type === 'url' || type === 'file' || type === 'git') {
        this.sourceType.set(type as SourceType);
      }
      if (typeof srcRec['location'] === 'string') {
        this.sourceLocation.set(srcRec['location']);
      }
      if (typeof srcRec['branch'] === 'string') {
        this.sourceBranch.set(srcRec['branch']);
      }
      if (typeof srcRec['refreshInterval'] === 'number') {
        this.refreshInterval.set(srcRec['refreshInterval']);
      }
    }

    return status;
  }

  private addEventLogEntry(kind: 'update' | 'error', summary: string): void {
    const entry: EventLogEntry = {
      id: ++eventLogIdCounter,
      kind,
      timestamp: Date.now(),
      summary,
    };
    // Keep the most recent 50 entries
    this.eventLog.update((log) => [entry, ...log].slice(0, 50));
  }

  private summarizePayload(data: unknown): string {
    if (data === null || data === undefined) return '(empty)';
    if (typeof data === 'string') return data.slice(0, 120);
    if (data instanceof Error) return data.message;

    try {
      const json = JSON.stringify(data);
      return json.length > 120 ? json.slice(0, 120) + '...' : json;
    } catch {
      return String(data);
    }
  }

  private assertSuccess(response: IpcResponse, fallback: string): void {
    if (!response.success) {
      throw new Error(response.error?.message ?? fallback);
    }
  }
}
