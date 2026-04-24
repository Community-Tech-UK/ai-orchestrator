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
import { ProviderIpcService } from '../../../core/services/ipc/provider-ipc.service';
import { ApiKeyManagerComponent } from './api-key-manager.component';
import { VerificationPreferencesComponent } from './verification-preferences.component';
import { getModelsForProvider } from '../../../../../shared/types/provider.types';

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
  templateUrl: './cli-settings-panel.component.html',
  styleUrl: './cli-settings-panel.component.scss',
})
export class CliSettingsPanelComponent implements OnInit {
  private store = inject(VerificationStore);
  private providerIpc = inject(ProviderIpcService);

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

  private readonly fallbackModelOptions: Record<string, string[]> = {
    claude: this.normalizeModelOptions('claude', getModelsForProvider('claude').map((model) => model.id)),
    gemini: this.normalizeModelOptions('gemini', getModelsForProvider('gemini').map((model) => model.id)),
    codex: this.normalizeModelOptions('codex', getModelsForProvider('codex').map((model) => model.id)),
    cursor: this.normalizeModelOptions('cursor', getModelsForProvider('cursor').map((model) => model.id)),
    ollama: ['llama3.3:70b', 'llama3.2:8b', 'codellama:34b', 'qwen2.5-coder:32b'],
    copilot: this.normalizeModelOptions('copilot', getModelsForProvider('copilot').map((model) => model.id)),
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
      availableModels: this.getFallbackModels(cli.command),
      error: cli.error,
    }));
    this.cliSettings.set(settings);
    void this.refreshAvailableModels(settings);
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
    this.updateCliSetting(command, {
      defaultModel: this.normalizeSelectedModel(command, select.value),
    });
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

  getAutoModelValue(command: string): string {
    return command === 'copilot' || command === 'cursor' ? 'auto' : '';
  }

  getSelectedModelValue(cli: CliSettingsEntry): string {
    return cli.defaultModel ?? this.getAutoModelValue(cli.command);
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

  private getFallbackModels(command: string): string[] {
    return [...(this.fallbackModelOptions[command] || [])];
  }

  private normalizeSelectedModel(command: string, value: string): string | undefined {
    const autoValue = this.getAutoModelValue(command);
    if (!value) {
      return autoValue || undefined;
    }
    if (value === autoValue) {
      return autoValue || undefined;
    }
    return value;
  }

  private normalizeModelOptions(command: string, modelIds: string[]): string[] {
    const autoValue = this.getAutoModelValue(command);
    return [...new Set(
      modelIds
        .map((modelId) => modelId.trim())
        .filter(Boolean)
        .filter((modelId) => modelId !== autoValue)
    )];
  }

  private supportsDynamicModelLookup(command: string): command is 'claude' | 'codex' | 'gemini' | 'copilot' | 'cursor' {
    return command === 'claude'
      || command === 'codex'
      || command === 'gemini'
      || command === 'copilot'
      || command === 'cursor';
  }

  private async refreshAvailableModels(settings: CliSettingsEntry[]): Promise<void> {
    const commands = [...new Set(
      settings
        .filter((cli) => cli.installed && this.supportsDynamicModelLookup(cli.command))
        .map((cli) => cli.command)
    )];

    await Promise.all(commands.map(async (command) => {
      try {
        const response = await this.providerIpc.listModelsForProvider(command);
        const discoveredModels = response.success
          ? this.normalizeModelOptions(command, (response.data ?? []).map((model) => model.id))
          : [];
        if (discoveredModels.length === 0) {
          return;
        }
        this.updateCliSetting(command, { availableModels: discoveredModels });
      } catch {
        // Keep fallback models when dynamic discovery fails.
      }
    }));
  }
}
