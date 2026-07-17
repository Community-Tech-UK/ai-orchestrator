/**
 * Editor Page
 * External editor integration — configure preferred editor, open files, and
 * inspect all detected editors.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';

// ─── Local interfaces ────────────────────────────────────────────────────────

interface EditorInfo {
  id: string;
  name: string;
  command?: string;
  path?: string;
  detected: boolean;
  version?: string;
}

// ─── Editor icon map ─────────────────────────────────────────────────────────

const EDITOR_ICONS: Record<string, string> = {
  vscode: '⬡',
  code: '⬡',
  vim: 'V',
  nvim: 'N',
  neovim: 'N',
  emacs: 'E',
  nano: 'n',
  sublime: 'S',
  atom: 'A',
  idea: 'I',
  webstorm: 'W',
  phpstorm: 'P',
  pycharm: 'Y',
  goland: 'G',
  clion: 'C',
  rider: 'R',
};

function editorIcon(id: string): string {
  const key = id.toLowerCase();
  for (const [k, v] of Object.entries(EDITOR_ICONS)) {
    if (key.includes(k)) return v;
  }
  return '#';
}

// ─── Component ───────────────────────────────────────────────────────────────

@Component({
  selector: 'app-editor-page',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">

      <!-- ===== Page Header ===== -->
      <div class="page-header">
        <div class="header-title">
          <span class="title">Editor Integration</span>
          <span class="subtitle">Configure and manage external editor connections</span>
        </div>
        <div class="header-actions">
          <button class="btn" type="button" [disabled]="working()" (click)="refresh()">
            {{ working() ? 'Loading…' : 'Refresh' }}
          </button>
        </div>
      </div>

      <!-- ===== Banners ===== -->
      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }
      @if (successMessage()) {
        <div class="success-banner">{{ successMessage() }}</div>
      }

      <!-- ===== Main Layout ===== -->
      <div class="main-layout">

        <!-- ---- Left column: current editor + quick actions ---- -->
        <div class="left-column">

          <!-- Current Editor Card -->
          <div class="card current-editor-card">
            <div class="card-header">
              <span class="card-title">Current Editor</span>
              @if (defaultEditor()) {
                <button class="btn" type="button" [disabled]="working()" (click)="showChangePicker.set(true)">
                  Change
                </button>
              }
            </div>

            @if (working() && !defaultEditor()) {
              <div class="loading-text">Loading…</div>
            } @else if (defaultEditor()) {
              <div class="current-editor-body">
                <div class="editor-icon-large">{{ iconFor(defaultEditor()!.id) }}</div>
                <div class="editor-meta">
                  <div class="editor-name-large">{{ defaultEditor()!.name }}</div>
                  @if (defaultEditor()!.path) {
                    <div class="editor-path">{{ defaultEditor()!.path }}</div>
                  }
                  @if (defaultEditor()!.version) {
                    <div class="editor-version">v{{ defaultEditor()!.version }}</div>
                  }
                  <span class="status-badge" [class]="defaultEditor()!.detected ? 'badge-detected' : 'badge-missing'">
                    <span class="badge-dot"></span>
                    {{ defaultEditor()!.detected ? 'Detected' : 'Not Found' }}
                  </span>
                </div>
              </div>
            } @else {
              <div class="hint">No default editor configured.</div>
            }

            <!-- Change picker inline ------>
            @if (showChangePicker()) {
              <div class="change-picker">
                <div class="card-title picker-label">Select New Default</div>
                @for (editor of availableEditors(); track editor.id) {
                  <button
                    class="picker-item"
                    type="button"
                    [class.picker-selected]="editor.id === defaultEditor()?.id"
                    [disabled]="working()"
                    (click)="setDefault(editor.id)"
                  >
                    <span class="picker-icon">{{ iconFor(editor.id) }}</span>
                    <span class="picker-name">{{ editor.name }}</span>
                    <span class="picker-status" [class]="editor.detected ? 'txt-detected' : 'txt-missing'">
                      {{ editor.detected ? 'detected' : 'not found' }}
                    </span>
                  </button>
                }
                <button class="btn btn-sm" type="button" (click)="showChangePicker.set(false)">
                  Cancel
                </button>
              </div>
            }
          </div>

          <!-- Quick Actions: Open File -->
          <div class="card">
            <div class="card-header">
              <span class="card-title">Quick Actions</span>
            </div>

            <div class="section-label">Open File</div>
            <div class="form-group">
              <input
                class="input"
                type="text"
                placeholder="File path…"
                [value]="openFilePath()"
                (input)="onFilePathInput($event)"
              />
            </div>
            <div class="form-row">
              <input
                class="input input-sm"
                type="number"
                placeholder="Line (optional)"
                [value]="openFileLine() ?? ''"
                (input)="onLineInput($event)"
              />
              <button
                class="btn"
                type="button"
                [disabled]="working() || !openFilePath()"
                (click)="openFile()"
              >
                Open
              </button>
            </div>
          </div>

        </div>

        <!-- ---- Right column: available editors grid ---- -->
        <div class="right-column">
          <div class="section-label editors-grid-label">Available Editors</div>

          @if (working() && availableEditors().length === 0) {
            <div class="loading-text">Detecting editors…</div>
          } @else if (availableEditors().length === 0) {
            <div class="hint">No editors detected on this system.</div>
          } @else {
            <div class="editors-grid">
              @for (editor of availableEditors(); track editor.id) {
                <div class="editor-card" [class.editor-card-default]="editor.id === defaultEditor()?.id">
                  <div class="editor-card-top">
                    <div class="editor-icon">{{ iconFor(editor.id) }}</div>
                    <div class="editor-card-info">
                      <div class="editor-card-name">{{ editor.name }}</div>
                      @if (editor.path) {
                        <div class="editor-card-path">{{ editor.path }}</div>
                      } @else if (editor.command) {
                        <div class="editor-card-path">{{ editor.command }}</div>
                      }
                    </div>
                    <span class="status-badge" [class]="editor.detected ? 'badge-detected' : 'badge-missing'">
                      <span class="badge-dot"></span>
                      {{ editor.detected ? 'Detected' : 'Not Found' }}
                    </span>
                  </div>
                  <div class="editor-card-actions">
                    @if (editor.id === defaultEditor()?.id) {
                      <span class="default-label">Default</span>
                    } @else {
                      <button
                        class="btn btn-sm"
                        type="button"
                        [disabled]="working()"
                        (click)="setDefault(editor.id)"
                      >
                        Set as Default
                      </button>
                    }
                  </div>
                </div>
              }
            </div>
          }
        </div>

      </div>

      <!-- ===== Detection Status Table ===== -->
      <div class="card table-card">
        <div class="card-header">
          <span class="card-title">Detection Status</span>
        </div>

        @if (availableEditors().length === 0) {
          <div class="hint">No editor data available. Click Refresh.</div>
        } @else {
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Command</th>
                  <th>Path</th>
                  <th>Detected</th>
                </tr>
              </thead>
              <tbody>
                @for (editor of availableEditors(); track editor.id) {
                  <tr class="table-row">
                    <td class="td-name">{{ editor.name }}</td>
                    <td class="td-mono">{{ editor.command ?? '—' }}</td>
                    <td class="td-mono td-path">{{ editor.path ?? '—' }}</td>
                    <td>
                      <span class="status-badge" [class]="editor.detected ? 'badge-detected' : 'badge-missing'">
                        <span class="badge-dot"></span>
                        {{ editor.detected ? 'Yes' : 'No' }}
                      </span>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </div>

    </div>
  `,
  styles: [`
    :host {
      display: flex;
      width: 100%;
      height: 100%;
    }

    /* ========== Page shell ========== */

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
      box-sizing: border-box;
    }

    /* ========== Header ========== */

    .page-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      flex-shrink: 0;
    }

    .header-title {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
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
      white-space: nowrap;
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-sm {
      padding: 2px var(--spacing-xs);
      font-size: 11px;
    }

    /* ========== Banners ========== */

    .error-banner,
    .success-banner {
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

    .success-banner {
      border: 1px solid color-mix(in srgb, var(--success-color) 60%, transparent);
      background: color-mix(in srgb, var(--success-color) 14%, transparent);
      color: var(--success-color);
    }

    /* ========== Main layout ========== */

    .main-layout {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: var(--spacing-md);
      flex-shrink: 0;
    }

    .left-column,
    .right-column {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
      min-width: 0;
    }

    /* ========== Card ========== */

    .card {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }

    .card-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted);
    }

    /* ========== Current Editor Card ========== */

    .current-editor-card {
      flex-shrink: 0;
    }

    .current-editor-body {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
    }

    .editor-icon-large {
      width: 48px;
      height: 48px;
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--primary-color) 18%, transparent);
      color: var(--primary-color);
      font-size: 22px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-family: var(--font-family-mono, monospace);
    }

    .editor-meta {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .editor-name-large {
      font-size: 15px;
      font-weight: 700;
    }

    .editor-path,
    .editor-version {
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--font-family-mono, monospace);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* ========== Change picker ========== */

    .change-picker {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      border-top: 1px solid var(--border-color);
      padding-top: var(--spacing-sm);
      margin-top: var(--spacing-xs);
    }

    .picker-label {
      margin-bottom: 2px;
    }

    .picker-item {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      padding: var(--spacing-xs) var(--spacing-sm);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      font-size: 12px;
      cursor: pointer;
      text-align: left;
      transition: border-color 0.1s;
    }

    .picker-item:hover {
      border-color: var(--primary-color);
    }

    .picker-item.picker-selected {
      border-color: var(--primary-color);
      background: color-mix(in srgb, var(--primary-color) 12%, transparent);
    }

    .picker-item:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .picker-icon {
      font-size: 14px;
      font-weight: 700;
      font-family: var(--font-family-mono, monospace);
      width: 20px;
      text-align: center;
      color: var(--primary-color);
      flex-shrink: 0;
    }

    .picker-name {
      flex: 1;
      min-width: 0;
    }

    .picker-status {
      font-size: 10px;
    }

    .txt-detected {
      color: var(--success-color);
    }

    .txt-missing {
      color: var(--text-muted);
    }

    /* ========== Input / Form ========== */

    .section-label {
      font-size: 10px;
      font-weight: 700;
      color: var(--text-muted);
    }

    .form-group {
      display: flex;
      flex-direction: column;
    }

    .form-row {
      display: flex;
      gap: var(--spacing-xs);
      align-items: center;
    }

    .input {
      flex: 1;
      min-width: 0;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
    }

    .input::placeholder {
      color: var(--text-muted);
    }

    .input-sm {
      width: 120px;
      flex: none;
    }

    /* ========== Available Editors Grid ========== */

    .editors-grid-label {
      flex-shrink: 0;
    }

    .editors-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: var(--spacing-sm);
    }

    .editor-card {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      padding: var(--spacing-sm);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .editor-card-default {
      border-color: color-mix(in srgb, var(--primary-color) 50%, transparent);
      background: color-mix(in srgb, var(--primary-color) 6%, var(--bg-secondary));
    }

    .editor-card-top {
      display: flex;
      align-items: flex-start;
      gap: var(--spacing-xs);
    }

    .editor-icon {
      width: 30px;
      height: 30px;
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--primary-color) 18%, transparent);
      color: var(--primary-color);
      font-size: 14px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-family: var(--font-family-mono, monospace);
    }

    .editor-card-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .editor-card-name {
      font-size: 12px;
      font-weight: 600;
    }

    .editor-card-path {
      font-size: 10px;
      color: var(--text-muted);
      font-family: var(--font-family-mono, monospace);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .editor-card-actions {
      display: flex;
      justify-content: flex-end;
    }

    .default-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--primary-color);
      padding: 2px var(--spacing-xs);
    }

    /* ========== Status badges ========== */

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 7px;
      border-radius: var(--radius-sm);
      font-size: 10px;
      font-weight: 600;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .badge-detected {
      background: color-mix(in srgb, var(--success-color) 14%, transparent);
      border: 1px solid color-mix(in srgb, var(--success-color) 40%, transparent);
      color: var(--success-color);
    }

    .badge-missing {
      background: color-mix(in srgb, var(--text-muted) 10%, transparent);
      border: 1px solid var(--border-color);
      color: var(--text-muted);
    }

    .badge-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: currentColor;
      flex-shrink: 0;
    }

    /* ========== Detection Status Table ========== */

    .table-card {
      flex-shrink: 0;
    }

    .table-wrap {
      overflow-x: auto;
    }

    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }

    .data-table th {
      text-align: left;
      padding: var(--spacing-xs) var(--spacing-sm);
      border-bottom: 1px solid var(--border-color);
      font-size: 10px;
      font-weight: 700;
      color: var(--text-muted);
      white-space: nowrap;
    }

    .table-row td {
      padding: var(--spacing-xs) var(--spacing-sm);
      border-bottom: 1px solid color-mix(in srgb, var(--border-color) 50%, transparent);
      vertical-align: middle;
    }

    .table-row:last-child td {
      border-bottom: none;
    }

    .td-name {
      font-weight: 600;
    }

    .td-mono {
      font-family: var(--font-family-mono, monospace);
      font-size: 11px;
      color: var(--text-muted);
    }

    .td-path {
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ========== Misc ========== */

    .hint {
      font-size: 12px;
      color: var(--text-muted);
      font-style: italic;
    }

    .loading-text {
      font-size: 12px;
      color: var(--text-muted);
    }
  `],
})
export class EditorPageComponent implements OnInit {
  private readonly fileIpc = inject(FileIpcService);

  // ---- Editor lists ----
  readonly availableEditors = signal<EditorInfo[]>([]);
  readonly defaultEditor = signal<EditorInfo | null>(null);

  // ---- Open-file form ----
  readonly openFilePath = signal('');
  readonly openFileLine = signal<number | null>(null);

  // ---- UI state ----
  readonly showChangePicker = signal(false);
  readonly working = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly successMessage = signal<string | null>(null);

  // ---- Derived ----
  readonly hasDefault = computed(() => this.defaultEditor() !== null);

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  iconFor(id: string): string {
    return editorIcon(id);
  }

  // ============================================================
  // Refresh
  // ============================================================

  async refresh(): Promise<void> {
    this.working.set(true);
    this.clearMessages();

    try {
      await Promise.all([this.loadAvailable(), this.loadDefault()]);
    } catch (err) {
      this.errorMessage.set((err as Error).message);
    } finally {
      this.working.set(false);
    }
  }

  // ============================================================
  // Load available editors
  // ============================================================

  private async loadAvailable(): Promise<void> {
    const response: IpcResponse = await this.fileIpc.editorGetAvailable();
    if (!response.success) return;

    const raw = response.data;
    if (!Array.isArray(raw)) return;

    const editors = (raw as unknown[])
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map((item): EditorInfo => ({
        id: String(item['id'] ?? item['name'] ?? 'unknown'),
        name: String(item['name'] ?? item['id'] ?? 'Unknown'),
        command: item['command'] != null ? String(item['command']) : undefined,
        path: item['path'] != null ? String(item['path']) : undefined,
        detected: Boolean(item['detected'] ?? item['available'] ?? false),
        version: item['version'] != null ? String(item['version']) : undefined,
      }));

    this.availableEditors.set(editors);
  }

  // ============================================================
  // Load default editor
  // ============================================================

  private async loadDefault(): Promise<void> {
    const response: IpcResponse = await this.fileIpc.editorGetDefault();
    if (!response.success) {
      this.defaultEditor.set(null);
      return;
    }

    const raw = response.data;
    if (raw === null || raw === undefined || typeof raw !== 'object') {
      this.defaultEditor.set(null);
      return;
    }

    const item = raw as Record<string, unknown>;
    this.defaultEditor.set({
      id: String(item['id'] ?? item['name'] ?? 'unknown'),
      name: String(item['name'] ?? item['id'] ?? 'Unknown'),
      command: item['command'] != null ? String(item['command']) : undefined,
      path: item['path'] != null ? String(item['path']) : undefined,
      detected: Boolean(item['detected'] ?? item['available'] ?? false),
      version: item['version'] != null ? String(item['version']) : undefined,
    });
  }

  // ============================================================
  // Set default editor
  // ============================================================

  async setDefault(editorId: string): Promise<void> {
    this.working.set(true);
    this.clearMessages();
    this.showChangePicker.set(false);

    try {
      const response: IpcResponse = await this.fileIpc.editorSetDefault(editorId);
      if (response.success) {
        this.successMessage.set('Default editor updated.');
        await this.refresh();
      } else {
        this.errorMessage.set(response.error?.message ?? 'Failed to set default editor.');
      }
    } catch (err) {
      this.errorMessage.set((err as Error).message);
    } finally {
      this.working.set(false);
    }
  }

  // ============================================================
  // Open file
  // ============================================================

  async openFile(): Promise<void> {
    const filePath = this.openFilePath();
    if (!filePath) return;

    this.working.set(true);
    this.clearMessages();

    const line = this.openFileLine();
    const options = line != null ? { line } : undefined;

    try {
      const response: IpcResponse = await this.fileIpc.editorOpen(filePath, options);
      if (response.success) {
        this.successMessage.set(`Opened: ${filePath}`);
      } else {
        this.errorMessage.set(response.error?.message ?? 'Failed to open file.');
      }
    } catch (err) {
      this.errorMessage.set((err as Error).message);
    } finally {
      this.working.set(false);
    }
  }

  // ============================================================
  // Input event handlers
  // ============================================================

  onFilePathInput(event: Event): void {
    this.openFilePath.set((event.target as HTMLInputElement).value);
  }

  onLineInput(event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    const parsed = parseInt(raw, 10);
    this.openFileLine.set(isNaN(parsed) ? null : parsed);
  }

  // ============================================================
  // Helpers
  // ============================================================

  private clearMessages(): void {
    this.errorMessage.set(null);
    this.successMessage.set(null);
  }
}
