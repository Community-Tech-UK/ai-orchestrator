/**
 * Logs & Debug Page
 * Application logs, debug commands, and diagnostics for the AI orchestrator.
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
import { LoggingIpcService } from '../../core/services/ipc/logging-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';

// ─── Local interfaces ─────────────────────────────────────────────────────────

interface LogEntry {
  timestamp: number;
  level: string;
  message: string;
  subsystem?: string;
  context?: string;
}

interface DebugCommand {
  name: string;
  description?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-logs-page',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="logs-page">

      <!-- Page header -->
      <div class="page-header">
        <div class="header-title">
          <span class="title">Logs &amp; Debug</span>
          <span class="subtitle">Application logs, debug commands, and diagnostics</span>
        </div>
        <div class="header-actions">
          <button
            class="btn"
            type="button"
            [disabled]="loading()"
            (click)="refresh()"
          >
            {{ loading() ? 'Loading...' : 'Refresh' }}
          </button>
        </div>
      </div>

      <!-- Tab bar -->
      <div class="tab-bar">
        <button
          class="tab-btn"
          [class.active]="activeTab() === 'viewer'"
          type="button"
          (click)="switchTab('viewer')"
        >Log Viewer</button>
        <button
          class="tab-btn"
          [class.active]="activeTab() === 'debug'"
          type="button"
          (click)="switchTab('debug')"
        >Debug Panel</button>
      </div>

      <!-- Error banner -->
      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }

      <!-- Info banner -->
      @if (infoMessage()) {
        <div class="info-banner">{{ infoMessage() }}</div>
      }

      <!-- Tab content -->
      <div class="tab-content">

        <!-- ── Tab 1: Log Viewer ──────────────────────────────────────────── -->
        @if (activeTab() === 'viewer') {
          <div class="viewer-tab">

            <!-- Filter bar -->
            <div class="filter-bar">
              <label class="filter-label" for="level-select">Level</label>
              <select
                id="level-select"
                class="filter-select"
                [value]="levelFilter()"
                (change)="onLevelFilterChange($event)"
              >
                <option value="all">All</option>
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>

              <label class="filter-label" for="subsystem-input">Subsystem</label>
              <input
                id="subsystem-input"
                class="filter-input subsystem-input"
                type="text"
                placeholder="e.g. InstanceManager"
                [value]="subsystemFilter()"
                (input)="onSubsystemInput($event)"
              />

              <label class="filter-label" for="limit-input">Limit</label>
              <input
                id="limit-input"
                class="filter-input limit-input"
                type="number"
                min="10"
                max="5000"
                [value]="logLimit()"
                (change)="onLimitChange($event)"
              />

              <div class="filter-spacer"></div>

              <button class="btn" type="button" [disabled]="working()" (click)="exportLogs()">
                Export
              </button>
              <button class="btn danger" type="button" [disabled]="working()" (click)="clearLogs()">
                Clear
              </button>
            </div>

            <!-- Log level control -->
            <div class="level-control-bar">
              <span class="filter-label">Active log level:</span>
              @for (lvl of logLevels; track lvl) {
                <button
                  class="level-pill"
                  [class.active]="activeLogLevel() === lvl"
                  type="button"
                  (click)="setLogLevel(lvl)"
                >{{ lvl }}</button>
              }
            </div>

            <!-- Log list -->
            <div class="log-list">
              @if (filteredEntries().length === 0) {
                <div class="empty-state">No log entries found.</div>
              } @else {
                @for (entry of filteredEntries(); track entry.timestamp + entry.message) {
                  <div class="log-entry" [class]="'log-entry-' + normalizeLevel(entry.level)">
                    <span class="log-ts mono">{{ formatTimestamp(entry.timestamp) }}</span>
                    <span class="log-badge" [class]="'badge-' + normalizeLevel(entry.level)">
                      {{ normalizeLevel(entry.level) }}
                    </span>
                    @if (entry.subsystem || entry.context) {
                      <span class="log-subsystem">{{ entry.subsystem ?? entry.context }}</span>
                    }
                    <span class="log-message mono">{{ entry.message }}</span>
                  </div>
                }
              }
            </div>

          </div>
        }

        <!-- ── Tab 2: Debug Panel ─────────────────────────────────────────── -->
        @if (activeTab() === 'debug') {
          <div class="debug-tab">

            <!-- Commands column -->
            <div class="debug-commands">
              <div class="panel-title">Available Commands</div>
              @if (debugCommands().length === 0) {
                <div class="empty-state">No commands available.</div>
              } @else {
                <div class="command-list">
                  @for (cmd of debugCommands(); track cmd.name) {
                    <button
                      class="command-item"
                      [class.selected]="selectedCommand() === cmd.name"
                      type="button"
                      (click)="selectCommand(cmd.name)"
                    >
                      <span class="command-name mono">{{ cmd.name }}</span>
                      @if (cmd.description) {
                        <span class="command-desc">{{ cmd.description }}</span>
                      }
                    </button>
                  }
                </div>
                <button
                  class="btn primary execute-btn"
                  type="button"
                  [disabled]="!selectedCommand() || executing()"
                  (click)="executeCommand()"
                >
                  {{ executing() ? 'Running...' : 'Execute' }}
                </button>
              }
            </div>

            <!-- Output column -->
            <div class="debug-output">
              <div class="panel-title">Command Output</div>
              @if (commandOutput()) {
                <pre class="output-block mono">{{ commandOutput() }}</pre>
              } @else {
                <div class="empty-state">Select a command and click Execute.</div>
              }
            </div>

            <!-- Diagnostics column -->
            <div class="debug-diagnostics">
              <div class="panel-title">System Diagnostics</div>
              @if (diagnosticsOutput()) {
                <pre class="output-block mono">{{ diagnosticsOutput() }}</pre>
              } @else {
                <div class="empty-state">
                  <button class="btn" type="button" [disabled]="loadingDiag()" (click)="runDiagnostics()">
                    {{ loadingDiag() ? 'Running...' : 'Run Diagnostics' }}
                  </button>
                </div>
              }

              <div class="panel-title diag-sep">System Info</div>
              @if (systemInfo()) {
                <pre class="output-block mono">{{ systemInfo() }}</pre>
              } @else {
                <div class="empty-state">
                  <button class="btn" type="button" [disabled]="loadingInfo()" (click)="loadSystemInfo()">
                    {{ loadingInfo() ? 'Loading...' : 'Load Info' }}
                  </button>
                </div>
              }
            </div>

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
      flex: 1;
    }

    .logs-page {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
      height: 100%;
      padding: var(--spacing-lg);
      background: var(--bg-primary);
      color: var(--text-primary);
      width: 100%;
      overflow: hidden;
    }

    /* ── Header ────────────────────────────────────────────────────────────── */

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
      gap: var(--spacing-sm);
    }

    /* ── Buttons ───────────────────────────────────────────────────────────── */

    .btn {
      padding: var(--spacing-xs) var(--spacing-md);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      cursor: pointer;
      font-size: 13px;
      white-space: nowrap;
    }

    .btn:hover:not(:disabled) {
      background: var(--bg-secondary);
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn.primary {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: #000;
      font-weight: 600;
    }

    .btn.primary:hover:not(:disabled) {
      opacity: 0.9;
    }

    .btn.danger {
      border-color: var(--error-color);
      color: var(--error-color);
    }

    .btn.danger:hover:not(:disabled) {
      background: color-mix(in srgb, var(--error-color) 15%, transparent);
    }

    /* ── Tabs ──────────────────────────────────────────────────────────────── */

    .tab-bar {
      display: flex;
      gap: 2px;
      border-bottom: 1px solid var(--border-color);
      flex-shrink: 0;
    }

    .tab-btn {
      padding: var(--spacing-xs) var(--spacing-md);
      border: none;
      border-bottom: 2px solid transparent;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 13px;
      transition: color 0.15s, border-color 0.15s;
    }

    .tab-btn.active {
      color: var(--text-primary);
      border-bottom-color: var(--primary-color);
    }

    .tab-btn:hover:not(.active) {
      color: var(--text-secondary);
    }

    /* ── Banners ───────────────────────────────────────────────────────────── */

    .error-banner {
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--error-color) 15%, transparent);
      border: 1px solid var(--error-color);
      color: var(--error-color);
      font-size: 13px;
      flex-shrink: 0;
    }

    .info-banner {
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--primary-color) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--primary-color) 60%, transparent);
      color: var(--text-primary);
      font-size: 13px;
      flex-shrink: 0;
    }

    /* ── Tab content ───────────────────────────────────────────────────────── */

    .tab-content {
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    /* ── Filter bar ────────────────────────────────────────────────────────── */

    .filter-bar {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding-bottom: var(--spacing-sm);
      flex-wrap: wrap;
      flex-shrink: 0;
    }

    .filter-label {
      font-size: 12px;
      color: var(--text-muted);
      white-space: nowrap;
    }

    .filter-select {
      padding: var(--spacing-xs) var(--spacing-sm);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-secondary);
      color: var(--text-primary);
      font-size: 12px;
    }

    .filter-input {
      padding: var(--spacing-xs) var(--spacing-sm);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-secondary);
      color: var(--text-primary);
      font-size: 12px;
    }

    .subsystem-input {
      width: 160px;
    }

    .limit-input {
      width: 72px;
    }

    .filter-spacer {
      flex: 1;
    }

    /* ── Level control bar ─────────────────────────────────────────────────── */

    .level-control-bar {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      padding-bottom: var(--spacing-sm);
      flex-shrink: 0;
      flex-wrap: wrap;
    }

    .level-pill {
      padding: 2px 10px;
      border-radius: 9999px;
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-muted);
      cursor: pointer;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      transition: background 0.12s, color 0.12s, border-color 0.12s;
    }

    .level-pill.active {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: #000;
      font-weight: 600;
    }

    /* ── Log list ──────────────────────────────────────────────────────────── */

    .viewer-tab {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    .log-list {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      display: flex;
      flex-direction: column;
    }

    .log-entry {
      display: flex;
      align-items: baseline;
      gap: var(--spacing-sm);
      padding: var(--spacing-xs) var(--spacing-sm);
      border-bottom: 1px solid color-mix(in srgb, var(--border-color) 50%, transparent);
      font-size: 12px;
      transition: background 0.1s;
    }

    .log-entry:last-child {
      border-bottom: none;
    }

    .log-entry:hover {
      background: var(--bg-tertiary);
    }

    .log-ts {
      color: var(--text-muted);
      white-space: nowrap;
      flex-shrink: 0;
      font-size: 11px;
    }

    .log-badge {
      display: inline-flex;
      align-items: center;
      padding: 1px 7px;
      border-radius: 9999px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      flex-shrink: 0;
    }

    .badge-debug {
      background: color-mix(in srgb, #6b7280 20%, transparent);
      color: #9ca3af;
      border: 1px solid #6b7280;
    }

    .badge-info {
      background: color-mix(in srgb, #3b82f6 20%, transparent);
      color: #60a5fa;
      border: 1px solid #3b82f6;
    }

    .badge-warn {
      background: color-mix(in srgb, #f59e0b 20%, transparent);
      color: #fbbf24;
      border: 1px solid #f59e0b;
    }

    .badge-error {
      background: color-mix(in srgb, var(--error-color) 20%, transparent);
      color: var(--error-color);
      border: 1px solid var(--error-color);
    }

    .log-subsystem {
      color: var(--text-muted);
      font-size: 11px;
      padding: 1px 6px;
      border-radius: var(--radius-sm);
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      white-space: nowrap;
      flex-shrink: 0;
    }

    .log-message {
      color: var(--text-primary);
      word-break: break-word;
      flex: 1;
    }

    .empty-state {
      padding: var(--spacing-lg);
      text-align: center;
      color: var(--text-muted);
      font-size: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--spacing-sm);
      flex-direction: column;
    }

    /* ── Debug Panel ───────────────────────────────────────────────────────── */

    .debug-tab {
      display: grid;
      grid-template-columns: 220px 1fr 280px;
      gap: var(--spacing-md);
      height: 100%;
      min-height: 0;
    }

    .debug-commands,
    .debug-output,
    .debug-diagnostics {
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
      text-transform: uppercase;
      letter-spacing: 0.05em;
      flex-shrink: 0;
    }

    .diag-sep {
      margin-top: var(--spacing-md);
    }

    .command-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      overflow-y: auto;
      flex: 1;
      min-height: 0;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      padding: var(--spacing-xs);
    }

    .command-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: var(--spacing-xs) var(--spacing-sm);
      border-radius: var(--radius-sm);
      border: 1px solid transparent;
      background: transparent;
      color: var(--text-primary);
      cursor: pointer;
      text-align: left;
      transition: background 0.1s, border-color 0.1s;
    }

    .command-item:hover {
      background: var(--bg-tertiary);
    }

    .command-item.selected {
      background: color-mix(in srgb, var(--primary-color) 15%, transparent);
      border-color: var(--primary-color);
    }

    .command-name {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .command-desc {
      font-size: 11px;
      color: var(--text-muted);
      white-space: normal;
    }

    .execute-btn {
      flex-shrink: 0;
      margin-top: var(--spacing-xs);
    }

    .output-block {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: var(--spacing-sm);
      border-radius: var(--radius-md);
      border: 1px solid var(--border-color);
      background: var(--bg-secondary);
      color: var(--text-secondary);
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
    }

    .debug-output {
      overflow: hidden;
    }

    .debug-diagnostics {
      overflow-y: auto;
    }

    .mono {
      font-family: var(--font-family-mono, monospace);
    }

    @media (max-width: 900px) {
      .debug-tab {
        grid-template-columns: 1fr;
        overflow-y: auto;
      }

      .debug-commands,
      .debug-output,
      .debug-diagnostics {
        height: auto;
        min-height: 200px;
      }

      .command-list {
        max-height: 200px;
      }

      .output-block {
        max-height: 300px;
      }
    }
  `],
})
export class LogsPageComponent implements OnInit {
  private readonly loggingIpc = inject(LoggingIpcService);

  // ── Tab state ──────────────────────────────────────────────────────────────

  readonly activeTab = signal<'viewer' | 'debug'>('viewer');

  // ── Global state ───────────────────────────────────────────────────────────

  readonly loading = signal(false);
  readonly working = signal(false);
  readonly errorMessage = signal('');
  readonly infoMessage = signal('');

  // ── Log viewer state ───────────────────────────────────────────────────────

  readonly logEntries = signal<LogEntry[]>([]);
  readonly levelFilter = signal<'all' | 'debug' | 'info' | 'warn' | 'error'>('all');
  readonly subsystemFilter = signal('');
  readonly logLimit = signal(200);
  readonly activeLogLevel = signal<'debug' | 'info' | 'warn' | 'error'>('info');

  readonly logLevels: readonly ('debug' | 'info' | 'warn' | 'error')[] = ['debug', 'info', 'warn', 'error'];

  readonly filteredEntries = computed(() => {
    const filter = this.levelFilter();
    const sub = this.subsystemFilter().trim().toLowerCase();
    let entries = this.logEntries();

    if (filter !== 'all') {
      entries = entries.filter(e => this.normalizeLevel(e.level) === filter);
    }
    if (sub) {
      entries = entries.filter(e => {
        const key = (e.subsystem ?? e.context ?? '').toLowerCase();
        return key.includes(sub);
      });
    }
    return entries;
  });

  // ── Debug panel state ──────────────────────────────────────────────────────

  readonly debugCommands = signal<DebugCommand[]>([]);
  readonly selectedCommand = signal('');
  readonly commandOutput = signal('');
  readonly executing = signal(false);

  readonly diagnosticsOutput = signal('');
  readonly systemInfo = signal('');
  readonly loadingDiag = signal(false);
  readonly loadingInfo = signal(false);

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  ngOnInit(): void {
    void this.loadLogs();
  }

  // ─── Tab switching ─────────────────────────────────────────────────────────

  switchTab(tab: 'viewer' | 'debug'): void {
    this.activeTab.set(tab);
    this.errorMessage.set('');
    this.infoMessage.set('');

    if (tab === 'viewer') {
      void this.loadLogs();
    } else {
      void this.loadDebugCommands();
    }
  }

  refresh(): void {
    this.errorMessage.set('');
    this.infoMessage.set('');
    if (this.activeTab() === 'viewer') {
      void this.loadLogs();
    } else {
      void this.loadDebugCommands();
      void this.runDiagnostics();
      void this.loadSystemInfo();
    }
  }

  // ─── Log viewer ────────────────────────────────────────────────────────────

  async loadLogs(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set('');

    try {
      const level = this.levelFilter() === 'all'
        ? undefined
        : this.levelFilter() as 'debug' | 'info' | 'warn' | 'error';

      const response = await this.loggingIpc.logGetLogs({
        level,
        limit: this.logLimit(),
      });

      const entries = this.unwrapData<LogEntry[]>(response, []);
      this.logEntries.set(entries);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to load logs');
    } finally {
      this.loading.set(false);
    }
  }

  async setLogLevel(level: 'debug' | 'info' | 'warn' | 'error'): Promise<void> {
    this.working.set(true);
    this.errorMessage.set('');
    try {
      const response = await this.loggingIpc.logSetLevel(level);
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to set log level');
        return;
      }
      this.activeLogLevel.set(level);
      this.infoMessage.set(`Log level set to ${level}`);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to set log level');
    } finally {
      this.working.set(false);
    }
  }

  async exportLogs(): Promise<void> {
    this.working.set(true);
    this.errorMessage.set('');
    try {
      const filePath = `logs-export-${Date.now()}.json`;
      const response = await this.loggingIpc.logExport(filePath);
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Export failed');
        return;
      }
      this.infoMessage.set(`Logs exported to ${filePath}`);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Export failed');
    } finally {
      this.working.set(false);
    }
  }

  async clearLogs(): Promise<void> {
    this.working.set(true);
    this.errorMessage.set('');
    try {
      const response = await this.loggingIpc.logClear();
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to clear logs');
        return;
      }
      this.logEntries.set([]);
      this.infoMessage.set('Logs cleared');
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to clear logs');
    } finally {
      this.working.set(false);
    }
  }

  onLevelFilterChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.levelFilter.set(target.value as 'all' | 'debug' | 'info' | 'warn' | 'error');
    void this.loadLogs();
  }

  onSubsystemInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.subsystemFilter.set(target.value);
  }

  onLimitChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    const value = parseInt(target.value, 10);
    if (!isNaN(value) && value >= 10) {
      this.logLimit.set(value);
      void this.loadLogs();
    }
  }

  // ─── Debug panel ───────────────────────────────────────────────────────────

  async loadDebugCommands(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set('');
    try {
      const response = await this.loggingIpc.debugGetCommands();
      const commands = this.unwrapData<DebugCommand[]>(response, []);
      this.debugCommands.set(commands);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to load debug commands');
    } finally {
      this.loading.set(false);
    }
  }

  selectCommand(name: string): void {
    this.selectedCommand.set(name);
    this.commandOutput.set('');
  }

  async executeCommand(): Promise<void> {
    const command = this.selectedCommand();
    if (!command) return;

    this.executing.set(true);
    this.commandOutput.set('');
    this.errorMessage.set('');

    try {
      const response = await this.loggingIpc.debugExecute(command);
      const result = this.unwrapData<unknown>(response, null);
      if (!response.success) {
        this.commandOutput.set(`Error: ${response.error?.message ?? 'Command failed'}`);
        return;
      }
      this.commandOutput.set(
        result != null ? JSON.stringify(result, null, 2) : '(no output)'
      );
    } catch (err) {
      this.commandOutput.set(`Error: ${err instanceof Error ? err.message : 'Command failed'}`);
    } finally {
      this.executing.set(false);
    }
  }

  async runDiagnostics(): Promise<void> {
    this.loadingDiag.set(true);
    this.errorMessage.set('');
    try {
      const response = await this.loggingIpc.debugRunDiagnostics();
      const result = this.unwrapData<unknown>(response, null);
      this.diagnosticsOutput.set(
        result != null ? JSON.stringify(result, null, 2) : '(no diagnostics data)'
      );
    } catch (err) {
      this.diagnosticsOutput.set(`Error: ${err instanceof Error ? err.message : 'Diagnostics failed'}`);
    } finally {
      this.loadingDiag.set(false);
    }
  }

  async loadSystemInfo(): Promise<void> {
    this.loadingInfo.set(true);
    this.errorMessage.set('');
    try {
      const response = await this.loggingIpc.debugGetInfo();
      const result = this.unwrapData<unknown>(response, null);
      this.systemInfo.set(
        result != null ? JSON.stringify(result, null, 2) : '(no system info)'
      );
    } catch (err) {
      this.systemInfo.set(`Error: ${err instanceof Error ? err.message : 'Failed to load info'}`);
    } finally {
      this.loadingInfo.set(false);
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  normalizeLevel(level: string): 'debug' | 'info' | 'warn' | 'error' {
    const l = (level ?? '').toLowerCase();
    if (l === 'debug') return 'debug';
    if (l === 'info') return 'info';
    if (l === 'warn' || l === 'warning') return 'warn';
    if (l === 'error') return 'error';
    return 'info';
  }

  formatTimestamp(ts: number): string {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
  }

  private unwrapData<T>(response: IpcResponse, fallback: T): T {
    return response.success ? ((response.data as T) ?? fallback) : fallback;
  }
}
