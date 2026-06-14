import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { SessionShareIpcService } from '../../core/services/ipc/session-share-ipc.service';
import type { SessionShareBundle } from '../../../../shared/types/session-share.types';

/** Thin view-model representing a saved share bundle path. */
interface SavedBundle {
  filePath: string;
  bundle: SessionShareBundle;
}

/**
 * SessionShareComponent
 *
 * Inline panel that lets a user preview and save a redacted session share bundle.
 * Accepts an active instance id OR a history entry id.  Placement: embed inside
 * the instance-detail action bar or the history-item expanded row — wherever the
 * host already knows the id.
 *
 * Usage:
 *   <app-session-share [instanceId]="myInstanceId" />
 *   <app-session-share [historyEntryId]="myEntryId" />
 */
@Component({
  selector: 'app-session-share',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="share-panel" aria-label="Session sharing">
      <header class="share-header">
        <svg class="share-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16"
             viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true">
          <circle cx="18" cy="5" r="3"></circle>
          <circle cx="6" cy="12" r="3"></circle>
          <circle cx="18" cy="19" r="3"></circle>
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
        </svg>
        <h3 class="share-title">Share Session</h3>
      </header>

      <p class="share-description">
        Create a redacted bundle file that can be shared with others or
        replayed locally. All secrets and absolute paths are scrubbed automatically.
      </p>

      @if (error()) {
        <div class="banner banner-error" role="alert">{{ error() }}</div>
      }

      @if (info()) {
        <div class="banner banner-info" role="status">{{ info() }}</div>
      }

      <!-- Actions row -->
      <div class="action-row">
        <button
          class="btn btn-secondary"
          type="button"
          [disabled]="loading() || !hasSource()"
          (click)="previewBundle()"
          title="Preview the redacted bundle metadata without saving"
        >
          @if (previewing()) {
            <span class="spinner" aria-hidden="true"></span>
          }
          Preview
        </button>

        <button
          class="btn btn-primary"
          type="button"
          [disabled]="loading() || !hasSource()"
          (click)="saveBundle()"
          title="Save redacted bundle to disk — a system save dialog will appear"
        >
          @if (saving()) {
            <span class="spinner" aria-hidden="true"></span>
          }
          Save Bundle…
        </button>
      </div>

      <!-- No source warning -->
      @if (!hasSource()) {
        <p class="empty-hint">Provide an instanceId or historyEntryId to enable sharing.</p>
      }

      <!-- Preview result -->
      @if (preview()) {
        <div class="bundle-card">
          <div class="bundle-card-header">
            <strong>Bundle Preview</strong>
            <span class="badge">Redacted</span>
          </div>

          <dl class="bundle-meta">
            <div class="meta-row">
              <dt>Source</dt>
              <dd>{{ preview()!.source.displayName }}</dd>
            </div>
            <div class="meta-row">
              <dt>Kind</dt>
              <dd>{{ preview()!.source.kind }}</dd>
            </div>
            <div class="meta-row">
              <dt>Messages</dt>
              <dd>{{ preview()!.summary.totalMessages }}</dd>
            </div>
            <div class="meta-row">
              <dt>Artifacts</dt>
              <dd>{{ preview()!.summary.artifactCount }}</dd>
            </div>
            <div class="meta-row">
              <dt>Attachments</dt>
              <dd>{{ preview()!.summary.attachmentCount }}</dd>
            </div>
            @if (preview()!.summary.redactedContentCount > 0) {
              <div class="meta-row">
                <dt>Redacted items</dt>
                <dd class="redacted-count">{{ preview()!.summary.redactedContentCount }}</dd>
              </div>
            }
          </dl>

          @if (preview()!.warnings.length > 0) {
            <ul class="bundle-warnings">
              @for (w of preview()!.warnings; track $index) {
                <li>{{ w }}</li>
              }
            </ul>
          }
        </div>
      }

      <!-- Saved bundle result -->
      @if (saved()) {
        <div class="bundle-card">
          <div class="bundle-card-header">
            <strong>Bundle Saved</strong>
            <span class="badge badge-success">Saved</span>
          </div>

          <div class="saved-path-row">
            <code class="saved-path" [title]="saved()!.filePath">{{ saved()!.filePath }}</code>
            <button
              class="btn btn-copy"
              type="button"
              (click)="copyPath()"
              title="Copy file path to clipboard"
            >
              @if (copied()) {
                Copied!
              } @else {
                Copy Path
              }
            </button>
          </div>

          <p class="saved-hint">
            Share this file with others. They can open it in Harness via
            <em>Replay &amp; Share → Load Bundle</em>.
          </p>
        </div>
      }
    </section>
  `,
  styles: [`
    :host {
      display: block;
    }

    .share-panel {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm, 8px);
      padding: var(--spacing-md, 12px);
      background: var(--bg-secondary, #1e1e2e);
      border: 1px solid var(--border-color, #3d3d5c);
      border-radius: var(--radius-md, 8px);
    }

    .share-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs, 6px);
    }

    .share-icon {
      flex-shrink: 0;
      color: var(--accent-color, #7c6af7);
    }

    .share-title {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary, #e0e0ef);
    }

    .share-description {
      margin: 0;
      font-size: 12px;
      color: var(--text-muted, #888);
      line-height: 1.5;
    }

    /* Banners */
    .banner {
      padding: var(--spacing-xs, 6px) var(--spacing-sm, 8px);
      border-radius: var(--radius-sm, 4px);
      font-size: 12px;
      line-height: 1.4;
    }

    .banner-error {
      border: 1px solid color-mix(in srgb, var(--error-color, #e05555) 60%, transparent);
      background: color-mix(in srgb, var(--error-color, #e05555) 14%, transparent);
      color: var(--error-color, #e05555);
    }

    .banner-info {
      border: 1px solid color-mix(in srgb, var(--success-color, #4caf82) 50%, transparent);
      background: color-mix(in srgb, var(--success-color, #4caf82) 12%, transparent);
      color: var(--success-color, #4caf82);
    }

    /* Action row */
    .action-row {
      display: flex;
      gap: var(--spacing-xs, 6px);
      flex-wrap: wrap;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: var(--spacing-xs, 6px) var(--spacing-md, 12px);
      border-radius: var(--radius-sm, 4px);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid transparent;
      transition: opacity 0.15s;
    }

    .btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .btn-secondary {
      background: var(--bg-tertiary, #2a2a3e);
      border-color: var(--border-color, #3d3d5c);
      color: var(--text-primary, #e0e0ef);
    }

    .btn-primary {
      background: var(--accent-color, #7c6af7);
      color: #fff;
    }

    .btn-copy {
      flex-shrink: 0;
      background: var(--bg-tertiary, #2a2a3e);
      border-color: var(--border-color, #3d3d5c);
      color: var(--text-primary, #e0e0ef);
      white-space: nowrap;
    }

    /* Spinner */
    .spinner {
      display: inline-block;
      width: 10px;
      height: 10px;
      border: 2px solid currentColor;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .empty-hint {
      margin: 0;
      font-size: 11px;
      color: var(--text-muted, #888);
      font-style: italic;
    }

    /* Bundle card */
    .bundle-card {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs, 6px);
      padding: var(--spacing-sm, 8px) var(--spacing-md, 12px);
      background: var(--bg-primary, #131320);
      border: 1px solid var(--border-color, #3d3d5c);
      border-radius: var(--radius-sm, 4px);
    }

    .bundle-card-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs, 6px);
      font-size: 12px;
    }

    .badge {
      padding: 2px 6px;
      border-radius: 10px;
      font-size: 10px;
      font-weight: 600;
      background: color-mix(in srgb, var(--accent-color, #7c6af7) 20%, transparent);
      color: var(--accent-color, #7c6af7);
    }

    .badge-success {
      background: color-mix(in srgb, var(--success-color, #4caf82) 20%, transparent);
      color: var(--success-color, #4caf82);
    }

    /* Meta list */
    .bundle-meta {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 2px 0;
      margin: 0;
    }

    .meta-row {
      display: contents;
    }

    .meta-row dt {
      font-size: 11px;
      color: var(--text-muted, #888);
      padding-right: var(--spacing-sm, 8px);
    }

    .meta-row dd {
      font-size: 11px;
      color: var(--text-primary, #e0e0ef);
      margin: 0;
    }

    .redacted-count {
      color: var(--warning-color, #e6a817);
    }

    /* Warnings */
    .bundle-warnings {
      margin: 0;
      padding-left: 16px;
      font-size: 11px;
      color: var(--warning-color, #e6a817);
    }

    /* Saved path */
    .saved-path-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs, 6px);
    }

    .saved-path {
      flex: 1;
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-secondary, #b0b0c8);
      background: var(--bg-tertiary, #2a2a3e);
      padding: 3px 6px;
      border-radius: var(--radius-sm, 4px);
    }

    .saved-hint {
      margin: 0;
      font-size: 11px;
      color: var(--text-muted, #888);
    }
  `],
})
export class SessionShareComponent {
  private readonly ipc = inject(SessionShareIpcService);

  // ---- Inputs ----
  readonly instanceId = input<string | undefined>(undefined);
  readonly historyEntryId = input<string | undefined>(undefined);

  // ---- State ----
  readonly previewing = signal(false);
  readonly saving = signal(false);
  readonly copied = signal(false);
  readonly error = signal<string | null>(null);
  readonly info = signal<string | null>(null);
  readonly preview = signal<SessionShareBundle | null>(null);
  readonly saved = signal<SavedBundle | null>(null);

  // ---- Derived ----
  readonly loading = computed(() => this.previewing() || this.saving());
  readonly hasSource = computed(
    () => !!this.instanceId() || !!this.historyEntryId(),
  );

  // ---- Actions ----

  async previewBundle(): Promise<void> {
    if (!this.hasSource() || this.loading()) {
      return;
    }

    this.previewing.set(true);
    this.error.set(null);
    this.info.set(null);
    this.saved.set(null);

    try {
      const response = this.instanceId()
        ? await this.ipc.previewForInstance(this.instanceId()!)
        : await this.ipc.previewForHistory(this.historyEntryId()!);

      if (!response.success) {
        this.error.set(response.error?.message ?? 'Preview failed');
        return;
      }

      this.preview.set(response.data as SessionShareBundle);
      this.info.set('Preview ready — click "Save Bundle…" to persist to disk.');
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Unexpected error during preview');
    } finally {
      this.previewing.set(false);
    }
  }

  async saveBundle(): Promise<void> {
    if (!this.hasSource() || this.loading()) {
      return;
    }

    this.saving.set(true);
    this.error.set(null);
    this.info.set(null);

    try {
      const response = this.instanceId()
        ? await this.ipc.saveForInstance(this.instanceId()!)
        : await this.ipc.saveForHistory(this.historyEntryId()!);

      if (!response.success) {
        const msg = response.error?.message ?? '';
        // SAVE_CANCELLED is not really an error — main process sends this message
        if (msg === 'Save cancelled') {
          this.info.set('Save cancelled.');
          return;
        }
        this.error.set(msg || 'Save failed');
        return;
      }

      const data = response.data as { filePath: string; bundle: SessionShareBundle };
      this.saved.set({ filePath: data.filePath, bundle: data.bundle });
      this.preview.set(data.bundle);
      this.info.set('Bundle saved successfully.');
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Unexpected error during save');
    } finally {
      this.saving.set(false);
    }
  }

  copyPath(): void {
    const filePath = this.saved()?.filePath;
    if (!filePath) {
      return;
    }

    try {
      void navigator.clipboard.writeText(filePath);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      this.error.set('Clipboard write not available');
    }
  }
}
