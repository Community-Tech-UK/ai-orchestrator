/**
 * Multi-Edit Page
 * Preview and apply multi-file edits with diffs.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import { DiffViewerComponent } from '../../shared/components/diff-viewer/diff-viewer.component';

interface EditOp {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

interface EditPreview {
  filePath: string;
  oldContent: string;
  newContent: string;
  additions: number;
  deletions: number;
}

@Component({
  selector: 'app-multi-edit-page',
  standalone: true,
  imports: [CommonModule, DiffViewerComponent],
  template: `
    <div class="page">
      <!-- Page Header -->
      <div class="page-header">
        <div class="header-title">
          <span class="title">Multi-Edit</span>
          <span class="subtitle">Preview and apply multi-file edits with diffs</span>
        </div>
        <div class="header-actions">
          <button class="btn" type="button" [disabled]="working()" (click)="resetAll()">Refresh</button>
        </div>
      </div>

      <!-- Error / Info banners -->
      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }

      @if (infoMessage()) {
        <div class="info-banner">{{ infoMessage() }}</div>
      }

      <!-- Edit input area -->
      <div class="input-area">
        <label class="field">
          <span class="label">Edit Operations (JSON)</span>
          <textarea
            class="textarea"
            [value]="editsJson()"
            placeholder='[{"filePath": "src/foo.ts", "oldString": "old text", "newString": "new text"}]'
            (input)="onEditsJsonInput($event)"
          ></textarea>
        </label>
        <div class="input-actions">
          <button
            class="btn primary"
            type="button"
            [disabled]="working() || !canPreview()"
            (click)="runPreview()"
          >
            {{ working() && previewPending() ? 'Previewing...' : 'Preview' }}
          </button>
        </div>
      </div>

      <!-- 2-column content layout (visible once preview is available) -->
      @if (previews().length > 0) {
        <div class="content-grid">
          <!-- Left: File list -->
          <div class="file-list-panel">
            <div class="panel-title">Files ({{ previews().length }})</div>
            <div class="file-list">
              @for (preview of previews(); track preview.filePath) {
                <button
                  class="file-card"
                  type="button"
                  [class.selected]="selectedFilePath() === preview.filePath"
                  (click)="selectFile(preview.filePath)"
                >
                  <div class="file-card-header">
                    <span class="file-status-icon">
                      @if (appliedFiles().has(preview.filePath)) {
                        <span class="icon-applied" title="Applied">&#10003;</span>
                      } @else {
                        <span class="icon-pending" title="Pending">&#9679;</span>
                      }
                    </span>
                    <span class="file-path" [title]="preview.filePath">{{ shortPath(preview.filePath) }}</span>
                  </div>
                  <div class="file-counts">
                    <span class="count additions">+{{ preview.additions }}</span>
                    <span class="count deletions">-{{ preview.deletions }}</span>
                  </div>
                </button>
              }
            </div>
          </div>

          <!-- Right: Diff viewer -->
          <div class="diff-panel">
            @if (selectedPreview()) {
              <div class="diff-file-header">{{ selectedPreview()!.filePath }}</div>
              <div class="diff-viewer-wrap">
                <app-diff-viewer
                  [oldContent]="selectedPreview()!.oldContent"
                  [newContent]="selectedPreview()!.newContent"
                  [fileName]="selectedPreview()!.filePath"
                />
              </div>
            } @else {
              <div class="diff-empty">Select a file from the list to view its diff.</div>
            }
          </div>
        </div>

        <!-- Bottom action bar -->
        <div class="action-bar">
          <div class="edit-stats">
            <span>{{ previews().length }} file(s)</span>
            <span class="stat-sep">·</span>
            <span class="stat-add">+{{ totalAdditions() }} additions</span>
            <span class="stat-sep">·</span>
            <span class="stat-del">-{{ totalDeletions() }} deletions</span>
          </div>
          <div class="bar-actions">
            <button
              class="btn danger"
              type="button"
              [disabled]="working()"
              (click)="rejectAll()"
            >
              Reject All
            </button>
            <button
              class="btn primary"
              type="button"
              [disabled]="working()"
              (click)="applyAll()"
            >
              {{ working() && applyPending() ? 'Applying...' : 'Apply All' }}
            </button>
          </div>
        </div>
      }
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
      overflow: auto;
    }

    /* Header */

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

    /* Banners */

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

    /* Input area */

    .input-area {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      padding: var(--spacing-md);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      flex-shrink: 0;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .label {
      font-size: 12px;
      color: var(--text-muted);
    }

    .textarea {
      width: 100%;
      min-height: 96px;
      resize: vertical;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
      font-family: var(--font-mono);
    }

    .input-actions {
      display: flex;
      justify-content: flex-end;
    }

    /* Buttons */

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
      color: #fff;
    }

    .btn.danger {
      background: var(--error-color);
      border-color: var(--error-color);
      color: #fff;
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    /* 2-column content grid */

    .content-grid {
      display: grid;
      grid-template-columns: 280px 1fr;
      gap: var(--spacing-md);
      flex: 1;
      min-height: 0;
    }

    /* File list panel */

    .file-list-panel {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      min-height: 0;
      overflow: hidden;
    }

    .panel-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted);
      flex-shrink: 0;
    }

    .file-list {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      overflow: auto;
      flex: 1;
      min-height: 0;
    }

    .file-card {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: var(--spacing-xs) var(--spacing-sm);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-secondary);
      cursor: pointer;
      text-align: left;
      color: var(--text-primary);
      transition: background var(--transition-fast), border-color var(--transition-fast);
      flex-shrink: 0;

      &:hover {
        background: var(--bg-hover);
      }

      &.selected {
        border-color: var(--primary-color);
        background: color-mix(in srgb, var(--primary-color) 10%, var(--bg-secondary));
      }
    }

    .file-card-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      min-width: 0;
    }

    .file-status-icon {
      flex-shrink: 0;
      font-size: 11px;
      line-height: 1;
    }

    .icon-applied {
      color: var(--success-color);
    }

    .icon-pending {
      color: var(--text-muted);
      font-size: 8px;
    }

    .file-path {
      font-size: 12px;
      font-family: var(--font-mono);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      flex: 1;
    }

    .file-counts {
      display: flex;
      gap: var(--spacing-xs);
    }

    .count {
      font-size: 11px;
      font-family: var(--font-mono);
      padding: 0 4px;
      border-radius: var(--radius-sm);
    }

    .count.additions {
      background: var(--success-bg);
      color: var(--success-color);
    }

    .count.deletions {
      background: var(--error-bg);
      color: var(--error-color);
    }

    /* Diff panel */

    .diff-panel {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      min-height: 0;
      overflow: hidden;
    }

    .diff-file-header {
      font-size: 12px;
      font-family: var(--font-mono);
      color: var(--text-secondary);
      flex-shrink: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .diff-viewer-wrap {
      flex: 1;
      min-height: 0;
      overflow: auto;
    }

    .diff-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      font-size: 13px;
      color: var(--text-muted);
      border: 1px dashed var(--border-color);
      border-radius: var(--radius-md);
    }

    /* Action bar */

    .action-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--spacing-md);
      padding: var(--spacing-sm) var(--spacing-md);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      flex-shrink: 0;
    }

    .edit-stats {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      font-size: 12px;
      color: var(--text-secondary);
    }

    .stat-sep {
      color: var(--text-muted);
    }

    .stat-add {
      color: var(--success-color);
      font-family: var(--font-mono);
    }

    .stat-del {
      color: var(--error-color);
      font-family: var(--font-mono);
    }

    .bar-actions {
      display: flex;
      gap: var(--spacing-sm);
    }

    @media (max-width: 900px) {
      .content-grid {
        grid-template-columns: 1fr;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MultiEditPageComponent {
  private readonly fileIpc = inject(FileIpcService);

  readonly editsJson = signal('');
  readonly previews = signal<EditPreview[]>([]);
  readonly selectedFilePath = signal<string | null>(null);
  readonly appliedFiles = signal<Set<string>>(new Set());

  readonly working = signal(false);
  readonly previewPending = signal(false);
  readonly applyPending = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly infoMessage = signal<string | null>(null);

  readonly canPreview = computed(() => this.editsJson().trim().length > 0);

  readonly selectedPreview = computed(() => {
    const path = this.selectedFilePath();
    if (!path) return null;
    return this.previews().find((p) => p.filePath === path) ?? null;
  });

  readonly totalAdditions = computed(() =>
    this.previews().reduce((sum, p) => sum + p.additions, 0)
  );

  readonly totalDeletions = computed(() =>
    this.previews().reduce((sum, p) => sum + p.deletions, 0)
  );

  resetAll(): void {
    this.editsJson.set('');
    this.previews.set([]);
    this.selectedFilePath.set(null);
    this.appliedFiles.set(new Set());
    this.errorMessage.set(null);
    this.infoMessage.set(null);
  }

  onEditsJsonInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.editsJson.set(target.value);
  }

  selectFile(filePath: string): void {
    this.selectedFilePath.set(filePath);
  }

  async runPreview(): Promise<void> {
    if (!this.canPreview() || this.working()) return;

    let parsed: EditOp[];
    try {
      const raw = JSON.parse(this.editsJson()) as unknown;
      if (!Array.isArray(raw)) {
        throw new Error('Expected a JSON array of edit operations.');
      }
      parsed = raw as EditOp[];
    } catch {
      this.errorMessage.set('Edit operations must be a valid JSON array.');
      return;
    }

    this.errorMessage.set(null);
    this.infoMessage.set(null);
    this.working.set(true);
    this.previewPending.set(true);

    try {
      const response = await this.fileIpc.multiEditPreview(
        parsed
      );
      this.assertSuccess(response, 'Preview failed.');

      const result = this.extractData<unknown>(response);
      const previews = this.parsePreviewResult(result);
      this.previews.set(previews);
      this.appliedFiles.set(new Set());
      this.selectedFilePath.set(previews.length > 0 ? previews[0].filePath : null);
      this.infoMessage.set(`Preview ready — ${previews.length} file(s) affected.`);
    } catch (error) {
      this.errorMessage.set((error as Error).message);
    } finally {
      this.working.set(false);
      this.previewPending.set(false);
    }
  }

  async applyAll(): Promise<void> {
    if (this.working()) return;

    let parsed: EditOp[];
    try {
      const raw = JSON.parse(this.editsJson()) as unknown;
      if (!Array.isArray(raw)) {
        throw new Error('Expected a JSON array of edit operations.');
      }
      parsed = raw as EditOp[];
    } catch {
      this.errorMessage.set('Edit operations must be a valid JSON array.');
      return;
    }

    this.errorMessage.set(null);
    this.infoMessage.set(null);
    this.working.set(true);
    this.applyPending.set(true);

    try {
      const response = await this.fileIpc.multiEditApply(
        parsed
      );
      this.assertSuccess(response, 'Apply failed.');

      const allPaths = new Set(this.previews().map((p) => p.filePath));
      this.appliedFiles.set(allPaths);
      this.infoMessage.set(`Applied ${allPaths.size} file edit(s) successfully.`);
    } catch (error) {
      this.errorMessage.set((error as Error).message);
    } finally {
      this.working.set(false);
      this.applyPending.set(false);
    }
  }

  rejectAll(): void {
    this.previews.set([]);
    this.selectedFilePath.set(null);
    this.appliedFiles.set(new Set());
    this.infoMessage.set('All pending edits rejected.');
    this.errorMessage.set(null);
  }

  shortPath(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    return parts.length > 3 ? `.../${parts.slice(-2).join('/')}` : filePath;
  }

  private parsePreviewResult(result: unknown): EditPreview[] {
    if (!result || typeof result !== 'object') return [];

    // The IPC result may be an array of previews directly or nested under a key
    const data = result as Record<string, unknown>;
    const items: unknown[] = Array.isArray(result)
      ? result
      : Array.isArray(data['previews'])
        ? (data['previews'] as unknown[])
        : Array.isArray(data['results'])
          ? (data['results'] as unknown[])
          : [];

    return items
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map((item) => ({
        filePath: String(item['filePath'] ?? item['path'] ?? ''),
        oldContent: String(item['oldContent'] ?? item['original'] ?? ''),
        newContent: String(item['newContent'] ?? item['modified'] ?? ''),
        additions: Number(item['additions'] ?? 0),
        deletions: Number(item['deletions'] ?? 0),
      }))
      .filter((p) => p.filePath.length > 0);
  }

  private assertSuccess(response: IpcResponse, fallback: string): void {
    if (!response.success) {
      throw new Error(response.error?.message || fallback);
    }
  }

  private extractData<T>(response: IpcResponse): T | null {
    return response.success ? (response.data as T) : null;
  }
}
