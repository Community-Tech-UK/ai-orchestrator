/**
 * CLI Settings Panel Component
 *
 * Dedicated settings page for configuring CLI tools:
 * - CLI paths and version info
 * - Default models per CLI
 * - Connection testing
 * - Auto-approve settings
 * - Custom CLI addition
 *
 * Based on Section 3.6 of the UI spec
 */

import {
  Component,
  signal,
  inject,
  OnInit,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { VerificationStore } from '../../../core/state/verification.store';
import { ApiKeyManagerComponent } from './api-key-manager.component';
import { VerificationPreferencesComponent } from './verification-preferences.component';

interface CliSettingsEntry {
  command: string;
  name: string;
  installed: boolean;
  version?: string;
  path?: string;
  authenticated?: boolean;
  defaultModel?: string;
  defaultTimeout: number;
  autoApprove: boolean;
  availableModels: string[];
  lastTested?: Date;
  testStatus?: 'success' | 'failed' | 'testing';
  error?: string;
}

@Component({
  selector: 'app-cli-settings-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, ApiKeyManagerComponent, VerificationPreferencesComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="settings-panel">
      <header class="panel-header">
        <h1>CLI & Agent Settings</h1>
        <button class="close-btn" (click)="close()">✕</button>
      </header>

      <!-- Tabs -->
      <nav class="settings-tabs">
        @for (tab of tabs; track tab.id) {
          <button
            [class.active]="activeTab() === tab.id"
            (click)="activeTab.set(tab.id)"
          >
            {{ tab.label }}
          </button>
        }
      </nav>

      <div class="settings-content">
        <!-- CLI Tools Tab -->
        @if (activeTab() === 'cli') {
          <div class="tab-content">
            <div class="section-header">
              <h2>Detected CLI Tools</h2>
              <button class="btn-secondary" (click)="rescanClis()" [disabled]="isScanning()">
                {{ isScanning() ? 'Scanning...' : '🔄 Rescan' }}
              </button>
            </div>

            <div class="cli-list">
              @for (cli of cliSettings(); track cli.command) {
                <div class="cli-card" [class.unavailable]="!cli.installed">
                  <div class="cli-header">
                    <div class="cli-status">
                      <span
                        class="status-dot"
                        [class.available]="cli.installed && cli.authenticated !== false"
                        [class.auth-required]="cli.installed && cli.authenticated === false"
                        [class.not-found]="!cli.installed"
                      ></span>
                      <h3>{{ cli.name }}</h3>
                    </div>
                    <span class="cli-status-text">
                      @if (cli.installed && cli.authenticated !== false) {
                        Installed & Authenticated
                      } @else if (cli.installed && cli.authenticated === false) {
                        Auth Required
                      } @else {
                        Not Found
                      }
                    </span>
                  </div>

                  @if (cli.installed) {
                    <div class="cli-details">
                      <div class="detail-row">
                        <span class="detail-label">Version:</span>
                        <span>{{ cli.version || 'Unknown' }}</span>
                      </div>

                      <div class="detail-row">
                        <span class="detail-label">Path:</span>
                        <div class="path-input">
                          <input
                            type="text"
                            [value]="cli.path || ''"
                            (change)="updateCliPath(cli.command, $event)"
                            placeholder="Auto-detected"
                          />
                          <button class="btn-small" (click)="browsePath(cli.command)">
                            Browse...
                          </button>
                        </div>
                      </div>

                      <div class="detail-row">
                        <span class="detail-label">Default Model:</span>
                        <select
                          [value]="cli.defaultModel || ''"
                          (change)="updateDefaultModel(cli.command, $event)"
                        >
                          <option value="">Auto</option>
                          @for (model of cli.availableModels; track model) {
                            <option [value]="model">{{ model }}</option>
                          }
                        </select>
                      </div>

                      <div class="detail-row">
                        <span class="detail-label">Default Timeout:</span>
                        <div class="timeout-input">
                          <input
                            type="number"
                            [value]="cli.defaultTimeout"
                            (change)="updateTimeout(cli.command, $event)"
                            min="30"
                            max="3600"
                          />
                          <span>seconds</span>
                        </div>
                      </div>

                      <div class="detail-row">
                        <span class="detail-label">Auto-approve:</span>
                        <label class="checkbox-label">
                          <input
                            type="checkbox"
                            [checked]="cli.autoApprove"
                            (change)="updateAutoApprove(cli.command, $event)"
                          />
                          <span>{{ getAutoApproveFlag(cli.command) }}</span>
                        </label>
                      </div>

                      <div class="cli-actions">
                        <button
                          class="btn-secondary"
                          (click)="testConnection(cli.command)"
                          [disabled]="cli.testStatus === 'testing'"
                        >
                          @if (cli.testStatus === 'testing') {
                            Testing...
                          } @else {
                            Test Connection
                          }
                        </button>
                        @if (cli.lastTested) {
                          <span class="test-result" [class.success]="cli.testStatus === 'success'" [class.failed]="cli.testStatus === 'failed'">
                            @if (cli.testStatus === 'success') {
                              ✓ Last tested: {{ formatTime(cli.lastTested) }}
                            } @else if (cli.testStatus === 'failed') {
                              ✗ Failed: {{ cli.error }}
                            }
                          </span>
                        }
                      </div>
                    </div>
                  } @else {
                    <div class="cli-not-found">
                      <p>The {{ cli.name }} CLI was not found on your system.</p>
                      <div class="not-found-actions">
                        <button class="btn-link" (click)="openInstallGuide(cli.command)">
                          📖 Installation Guide
                        </button>
                        <button class="btn-link" (click)="useApiFallback(cli.command)">
                          Use API Fallback Instead
                        </button>
                      </div>
                    </div>
                  }
                </div>
              }
            </div>

            <!-- Add Custom CLI -->
            <div class="add-custom-cli">
              <button class="btn-dashed" (click)="showAddCustomCli.set(true)">
                + Add Custom CLI Tool
              </button>
              <p class="hint">Supports: Aider, Continue, Cursor, Cody, or any compatible CLI</p>
            </div>

            @if (showAddCustomCli()) {
              <div class="custom-cli-form">
                <h4>Add Custom CLI</h4>
                <div class="form-row">
                  <span class="form-label">Name:</span>
                  <input type="text" [(ngModel)]="customCliName" placeholder="My Custom CLI" />
                </div>
                <div class="form-row">
                  <span class="form-label">Command:</span>
                  <input type="text" [(ngModel)]="customCliCommand" placeholder="mycli" />
                </div>
                <div class="form-row">
                  <span class="form-label">Path (optional):</span>
                  <input type="text" [(ngModel)]="customCliPath" placeholder="/usr/local/bin/mycli" />
                </div>
                <div class="form-actions">
                  <button class="btn-secondary" (click)="showAddCustomCli.set(false)">Cancel</button>
                  <button class="btn-primary" (click)="addCustomCli()">Add CLI</button>
                </div>
              </div>
            }
          </div>
        }

        <!-- API Keys Tab -->
        @if (activeTab() === 'api-keys') {
          <app-api-key-manager />
        }

        <!-- Defaults Tab -->
        @if (activeTab() === 'defaults') {
          <app-verification-preferences />
        }

        <!-- Advanced Tab -->
        @if (activeTab() === 'advanced') {
          <div class="tab-content">
            <h2>Advanced Settings</h2>

            <div class="setting-group">
              <h3>Performance</h3>
              <div class="setting-row">
                <label>
                  <input type="checkbox" [(ngModel)]="parallelExecution" />
                  Enable parallel agent execution
                </label>
                <p class="setting-hint">Run multiple agents simultaneously for faster results</p>
              </div>
              <div class="setting-row">
                <span class="setting-label">Max concurrent agents:</span>
                <input type="number" [(ngModel)]="maxConcurrent" min="1" max="10" />
              </div>
            </div>

            <div class="setting-group">
              <h3>Caching</h3>
              <div class="setting-row">
                <label>
                  <input type="checkbox" [(ngModel)]="enableCaching" />
                  Cache CLI detection results
                </label>
                <p class="setting-hint">Speeds up startup by caching detected CLIs</p>
              </div>
              <div class="setting-row">
                <span class="setting-label">Cache duration:</span>
                <select [(ngModel)]="cacheDuration">
                  <option value="300">5 minutes</option>
                  <option value="3600">1 hour</option>
                  <option value="86400">24 hours</option>
                </select>
              </div>
            </div>

            <div class="setting-group">
              <h3>Logging</h3>
              <div class="setting-row">
                <label>
                  <input type="checkbox" [(ngModel)]="verboseLogging" />
                  Enable verbose logging
                </label>
                <p class="setting-hint">Log detailed CLI interactions for debugging</p>
              </div>
              <div class="setting-row">
                <label>
                  <input type="checkbox" [(ngModel)]="saveRawResponses" />
                  Save raw responses to disk
                </label>
                <p class="setting-hint">Store complete agent responses for later analysis</p>
              </div>
            </div>

            <div class="setting-group danger-zone">
              <h3>Danger Zone</h3>
              <div class="setting-row">
                <button class="btn-danger" (click)="clearAllData()">
                  Clear All Verification Data
                </button>
                <p class="setting-hint">Removes all session history and cached data</p>
              </div>
              <div class="setting-row">
                <button class="btn-danger" (click)="resetToDefaults()">
                  Reset All Settings
                </button>
                <p class="setting-hint">Restore all settings to factory defaults</p>
              </div>
            </div>
          </div>
        }
      </div>

      <!-- Footer -->
      <footer class="panel-footer">
        <button class="btn-secondary" (click)="close()">Cancel</button>
        <button class="btn-primary" (click)="saveSettings()">Save Settings</button>
      </footer>
    </div>
  `,
  styles: [`
    .settings-panel {
      display: flex;
      flex-direction: column;
      height: 100%;
      max-height: 90vh;
      background: var(--bg-primary);
      border-radius: 12px;
      overflow: hidden;
    }

    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 24px;
      border-bottom: 1px solid var(--border-color);
    }

    .panel-header h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
    }

    .close-btn {
      background: none;
      border: none;
      font-size: 20px;
      cursor: pointer;
      color: var(--text-secondary);
      padding: 4px 8px;
      border-radius: 4px;
    }

    .close-btn:hover {
      background: var(--bg-tertiary);
    }

    .settings-tabs {
      display: flex;
      gap: 0;
      padding: 0 24px;
      border-bottom: 1px solid var(--border-color);
    }

    .settings-tabs button {
      padding: 12px 20px;
      border: none;
      background: none;
      font-size: 14px;
      font-weight: 500;
      color: var(--text-secondary);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
    }

    .settings-tabs button:hover {
      color: var(--text-primary);
    }

    .settings-tabs button.active {
      color: var(--accent-color);
      border-bottom-color: var(--accent-color);
    }

    .settings-content {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
    }

    .tab-content {
      animation: fadeIn 0.2s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }

    .section-header h2 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
    }

    .cli-list {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .cli-card {
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 16px;
      background: var(--bg-secondary);
    }

    .cli-card.unavailable {
      opacity: 0.7;
    }

    .cli-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .cli-status {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .cli-status h3 {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
    }

    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }

    .status-dot.available {
      background: #22c55e;
    }

    .status-dot.auth-required {
      background: #f59e0b;
    }

    .status-dot.not-found {
      background: #ef4444;
    }

    .cli-status-text {
      font-size: 12px;
      color: var(--text-secondary);
    }

    .cli-details {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .detail-row {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .detail-row > .detail-label {
      width: 120px;
      font-size: 13px;
      color: var(--text-secondary);
      flex-shrink: 0;
    }

    .detail-row input[type="text"],
    .detail-row input[type="number"],
    .detail-row select {
      flex: 1;
      padding: 8px 12px;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      font-size: 13px;
      background: var(--bg-primary);
    }

    .path-input {
      display: flex;
      gap: 8px;
      flex: 1;
    }

    .path-input input {
      flex: 1;
    }

    .timeout-input {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .timeout-input input {
      width: 80px;
    }

    .timeout-input span {
      color: var(--text-secondary);
      font-size: 13px;
    }

    .checkbox-label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      cursor: pointer;
    }

    .checkbox-label input {
      width: 16px;
      height: 16px;
    }

    .cli-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 8px;
      padding-top: 12px;
      border-top: 1px solid var(--border-color);
    }

    .test-result {
      font-size: 12px;
    }

    .test-result.success {
      color: #22c55e;
    }

    .test-result.failed {
      color: #ef4444;
    }

    .cli-not-found {
      padding: 16px;
      background: var(--bg-tertiary);
      border-radius: 6px;
    }

    .cli-not-found p {
      margin: 0 0 12px;
      color: var(--text-secondary);
      font-size: 13px;
    }

    .not-found-actions {
      display: flex;
      gap: 16px;
    }

    .add-custom-cli {
      margin-top: 20px;
      text-align: center;
    }

    .btn-dashed {
      padding: 12px 24px;
      border: 2px dashed var(--border-color);
      background: none;
      border-radius: 8px;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 14px;
    }

    .btn-dashed:hover {
      border-color: var(--accent-color);
      color: var(--accent-color);
    }

    .hint {
      margin-top: 8px;
      font-size: 12px;
      color: var(--text-muted);
    }

    .custom-cli-form {
      margin-top: 16px;
      padding: 16px;
      background: var(--bg-secondary);
      border-radius: 8px;
      border: 1px solid var(--border-color);
    }

    .custom-cli-form h4 {
      margin: 0 0 16px;
      font-size: 14px;
    }

    .form-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }

    .form-row .form-label {
      width: 100px;
      font-size: 13px;
    }

    .form-row input {
      flex: 1;
      padding: 8px 12px;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      font-size: 13px;
    }

    .form-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 16px;
    }

    /* Setting Groups */
    .setting-group {
      margin-bottom: 24px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border-color);
    }

    .setting-group:last-child {
      border-bottom: none;
    }

    .setting-group h3 {
      margin: 0 0 16px;
      font-size: 14px;
      font-weight: 600;
    }

    .setting-row {
      margin-bottom: 12px;
    }

    .setting-row label,
    .setting-row .setting-label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
    }

    .setting-hint {
      margin: 4px 0 0 24px;
      font-size: 12px;
      color: var(--text-muted);
    }

    .danger-zone {
      background: rgba(239, 68, 68, 0.1);
      padding: 16px;
      border-radius: 8px;
      margin-top: 24px;
    }

    .danger-zone h3 {
      color: #ef4444;
    }

    /* Buttons */
    .btn-primary {
      padding: 10px 20px;
      background: var(--accent-color);
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
    }

    .btn-primary:hover {
      opacity: 0.9;
    }

    .btn-secondary {
      padding: 8px 16px;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
    }

    .btn-secondary:hover {
      background: var(--bg-hover);
    }

    .btn-secondary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-small {
      padding: 6px 12px;
      font-size: 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      cursor: pointer;
    }

    .btn-link {
      background: none;
      border: none;
      color: var(--accent-color);
      cursor: pointer;
      font-size: 13px;
      text-decoration: underline;
    }

    .btn-danger {
      padding: 8px 16px;
      background: #ef4444;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
    }

    .btn-danger:hover {
      background: #dc2626;
    }

    /* Footer */
    .panel-footer {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      padding: 16px 24px;
      border-top: 1px solid var(--border-color);
      background: var(--bg-secondary);
    }
  `],
})
export class CliSettingsPanelComponent implements OnInit {
  private store = inject(VerificationStore);

  // Tabs
  tabs = [
    { id: 'cli', label: 'CLI Tools' },
    { id: 'api-keys', label: 'API Keys' },
    { id: 'defaults', label: 'Defaults' },
    { id: 'advanced', label: 'Advanced' },
  ];
  activeTab = signal<string>('cli');

  // CLI State
  cliSettings = signal<CliSettingsEntry[]>([]);
  isScanning = signal(false);
  showAddCustomCli = signal(false);

  // Custom CLI form
  customCliName = '';
  customCliCommand = '';
  customCliPath = '';

  // Advanced settings
  parallelExecution = true;
  maxConcurrent = 4;
  enableCaching = true;
  cacheDuration = '3600';
  verboseLogging = false;
  saveRawResponses = false;

  // Available models per CLI
  private modelOptions: Record<string, string[]> = {
    claude: ['opus', 'sonnet', 'haiku'],
    gemini: ['gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    codex: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2', 'o3'],
    ollama: ['llama3.3:70b', 'llama3.2:8b', 'codellama:34b', 'qwen2.5-coder:32b'],
    copilot: ['claude-opus-4-5', 'o3', 'gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-2.5-pro', 'claude-sonnet-4-5', 'gpt-5.4', 'gemini-3-flash-preview', 'gemini-2.0-flash', 'claude-haiku-4-5', 'gpt-5.4-mini'], // Copilot uses full model IDs
  };

  ngOnInit(): void {
    this.loadCliSettings();
  }

  private loadCliSettings(): void {
    const detected = this.store.detectedClis();
    const settings: CliSettingsEntry[] = detected.map(cli => ({
      command: cli.command,
      name: cli.displayName,
      installed: cli.installed,
      version: cli.version,
      path: cli.path,
      authenticated: cli.authenticated,
      defaultModel: undefined,
      defaultTimeout: cli.command === 'ollama' ? 600 : 300,
      autoApprove: true,
      availableModels: this.modelOptions[cli.command] || [],
      error: cli.error,
    }));
    this.cliSettings.set(settings);
  }

  async rescanClis(): Promise<void> {
    this.isScanning.set(true);
    try {
      await this.store.scanClis();
      this.loadCliSettings();
    } finally {
      this.isScanning.set(false);
    }
  }

  async testConnection(cliCommand: string): Promise<void> {
    this.updateCliSetting(cliCommand, { testStatus: 'testing' });

    try {
      // Call IPC to test connection
      const result = await (window as unknown as { electronAPI?: { invoke: (channel: string, arg?: unknown) => Promise<unknown> } }).electronAPI?.invoke('cli:test-connection', { command: cliCommand }) as { success?: boolean; error?: string } | undefined;

      this.updateCliSetting(cliCommand, {
        testStatus: result?.success ? 'success' : 'failed',
        lastTested: new Date(),
        error: result?.error,
      });
    } catch (error) {
      this.updateCliSetting(cliCommand, {
        testStatus: 'failed',
        lastTested: new Date(),
        error: (error as Error).message,
      });
    }
  }

  updateCliPath(command: string, event: Event): void {
    const input = event.target as HTMLInputElement;
    this.updateCliSetting(command, { path: input.value });
  }

  updateDefaultModel(command: string, event: Event): void {
    const select = event.target as HTMLSelectElement;
    this.updateCliSetting(command, { defaultModel: select.value || undefined });
  }

  updateTimeout(command: string, event: Event): void {
    const input = event.target as HTMLInputElement;
    this.updateCliSetting(command, { defaultTimeout: parseInt(input.value) || 300 });
  }

  updateAutoApprove(command: string, event: Event): void {
    const input = event.target as HTMLInputElement;
    this.updateCliSetting(command, { autoApprove: input.checked });
  }

  private updateCliSetting(command: string, updates: Partial<CliSettingsEntry>): void {
    this.cliSettings.update(settings =>
      settings.map(cli =>
        cli.command === command ? { ...cli, ...updates } : cli
      )
    );
  }

  getAutoApproveFlag(command: string): string {
    const flags: Record<string, string> = {
      claude: '--dangerously-skip-permissions',
      gemini: '--yolo',
      codex: '--auto-approve',
      ollama: 'N/A (local)',
    };
    return flags[command] || '--auto';
  }

  browsePath(command: string): void {
    // Open file dialog via IPC
    (window as unknown as { electronAPI?: { invoke: (channel: string, arg?: unknown) => Promise<unknown> } }).electronAPI?.invoke('dialog:open-file', {
      title: `Select ${command} CLI executable`,
      filters: [{ name: 'Executables', extensions: ['*'] }],
    }).then((result: unknown) => {
      const res = result as { filePath?: string } | undefined;
      if (res?.filePath) {
        this.updateCliSetting(command, { path: res.filePath });
      }
    }).catch(() => {
      // Handle error silently
    });
  }

  openInstallGuide(command: string): void {
    const guides: Record<string, string> = {
      claude: 'https://docs.anthropic.com/claude-code/installation',
      gemini: 'https://ai.google.dev/gemini-cli/install',
      codex: 'https://openai.com/codex-cli/setup',
      ollama: 'https://ollama.ai/download',
    };
    const url = guides[command];
    if (url) {
      (window as unknown as { electronAPI?: { invoke: (channel: string, arg?: unknown) => Promise<unknown> } }).electronAPI?.invoke('shell:open-external', url).catch(() => {
        // Handle error silently
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  useApiFallback(_command?: string): void {
    // Switch to API tab and show API key setup
    this.activeTab.set('api-keys');
  }

  addCustomCli(): void {
    if (!this.customCliName || !this.customCliCommand) return;

    const newCli: CliSettingsEntry = {
      command: this.customCliCommand,
      name: this.customCliName,
      installed: false, // Will be checked
      path: this.customCliPath || undefined,
      defaultTimeout: 300,
      autoApprove: false,
      availableModels: [],
    };

    this.cliSettings.update(settings => [...settings, newCli]);

    // Reset form
    this.customCliName = '';
    this.customCliCommand = '';
    this.customCliPath = '';
    this.showAddCustomCli.set(false);

    // Try to detect the new CLI
    this.testConnection(this.customCliCommand);
  }

  formatTime(date: Date): string {
    const now = new Date();
    const diff = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
    return date.toLocaleDateString();
  }

  clearAllData(): void {
    if (confirm('Are you sure you want to clear all verification data? This cannot be undone.')) {
      this.store.clearHistory();
    }
  }

  resetToDefaults(): void {
    if (confirm('Reset all settings to defaults? This cannot be undone.')) {
      // Reset settings
      this.parallelExecution = true;
      this.maxConcurrent = 4;
      this.enableCaching = true;
      this.cacheDuration = '3600';
      this.verboseLogging = false;
      this.saveRawResponses = false;
      this.loadCliSettings();
    }
  }

  saveSettings(): void {
    // Save all settings via store/IPC
    const settings = {
      clis: this.cliSettings(),
      advanced: {
        parallelExecution: this.parallelExecution,
        maxConcurrent: this.maxConcurrent,
        enableCaching: this.enableCaching,
        cacheDuration: parseInt(this.cacheDuration),
        verboseLogging: this.verboseLogging,
        saveRawResponses: this.saveRawResponses,
      },
    };

    // Save settings (advanced settings are saved via localStorage in real implementation)
    // Note: VerificationUIConfig doesn't have these advanced settings, so we log them for now
    console.log('Advanced settings saved:', settings.advanced);

    this.close();
  }

  close(): void {
    // Emit close event or navigate back
    history.back();
  }
}
