/**
 * Plugins Page
 * Plugin discovery, installation, and management.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { PluginIpcService } from '../../core/services/ipc/plugin-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import type { PluginPackageSource } from '@contracts/schemas/plugin';

// ─── Local interfaces ─────────────────────────────────────────────────────────

interface PluginInfo {
  id: string;
  name: string;
  version?: string;
  description?: string;
  status: 'loaded' | 'unloaded' | 'error';
  path?: string;
}

interface RuntimePluginInfo {
  id: string;
  name: string;
  version?: string;
  status: 'installed' | 'missing';
  installPath?: string;
  lastUpdatedAt?: number;
}

type RuntimeValidationResult =
  | {
      ok: true;
      manifest: { name: string; version: string; description?: string };
      warnings: string[];
    }
  | {
      ok: false;
      errors: string[];
      warnings: string[];
    };

type ActiveTab = 'installed' | 'discover';

// ─── Component ────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-plugins-page',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="page">

      <!-- Page Header -->
      <div class="page-header">
        <button class="header-btn" type="button" (click)="goBack()">← Back</button>
        <div class="header-title">
          <span class="title">Plugins</span>
          <span class="subtitle">Plugin discovery, installation, and management</span>
        </div>
        <div class="header-actions">
          <button class="btn" type="button" [disabled]="loading()" (click)="refresh()">
            {{ loading() ? 'Refreshing…' : 'Refresh' }}
          </button>
        </div>
      </div>

      <!-- Metric Cards -->
      <div class="metrics">
        <div class="metric-card">
          <span class="metric-label">Loaded Plugins</span>
          <span class="metric-value">{{ loadedCount() }}</span>
        </div>
        <div class="metric-card">
          <span class="metric-label">Available</span>
          <span class="metric-value">{{ availableCount() }}</span>
        </div>
        <div class="metric-card">
          <span class="metric-label">Installed</span>
          <span class="metric-value">{{ installedCount() }}</span>
        </div>
        <div class="metric-card">
          <span class="metric-label">Runtime Packages</span>
          <span class="metric-value">{{ runtimePackageCount() }}</span>
        </div>
      </div>

      <!-- Error Banner -->
      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }

      <!-- Tab Panel -->
      <div class="panel">
        <div class="tab-bar">
          <button
            class="tab"
            type="button"
            [class.active]="activeTab() === 'installed'"
            (click)="setTab('installed')"
          >Installed</button>
          <button
            class="tab"
            type="button"
            [class.active]="activeTab() === 'discover'"
            (click)="setTab('discover')"
          >Discover</button>
        </div>

        <!-- Installed Tab -->
        @if (activeTab() === 'installed') {
          <div class="tab-content">
            <div class="section-title">Provider Plugins</div>
            @if (loadedPlugins().length === 0) {
              <div class="empty-state">No plugins currently loaded.</div>
            } @else {
              <div class="plugin-grid">
                @for (plugin of loadedPlugins(); track plugin.id) {
                  <div class="plugin-card">
                    <div class="plugin-card-header">
                      <span class="plugin-name">{{ plugin.name }}</span>
                      @if (plugin.version) {
                        <span class="plugin-version">v{{ plugin.version }}</span>
                      }
                      <span class="status-badge" [class]="'status-' + plugin.status">
                        {{ plugin.status }}
                      </span>
                    </div>
                    @if (plugin.description) {
                      <p class="plugin-description">{{ plugin.description }}</p>
                    }
                    <div class="plugin-actions">
                      @if (plugin.status === 'unloaded') {
                        <button
                          class="btn primary small"
                          type="button"
                          [disabled]="working()"
                          (click)="loadPlugin(plugin.id)"
                        >Load</button>
                      } @else {
                        <button
                          class="btn small"
                          type="button"
                          [disabled]="working()"
                          (click)="unloadPlugin(plugin.id)"
                        >Unload</button>
                      }
                      <button
                        class="btn danger small"
                        type="button"
                        [disabled]="working()"
                        (click)="uninstallPlugin(plugin.id)"
                      >Uninstall</button>
                    </div>
                  </div>
                }
              </div>
            }

            <div class="section-title">Runtime Plugin Packages</div>
            @if (runtimePlugins().length === 0) {
              <div class="empty-state">No runtime plugin packages installed.</div>
            } @else {
              <div class="plugin-grid">
                @for (plugin of runtimePlugins(); track plugin.id) {
                  <div class="plugin-card">
                    <div class="plugin-card-header">
                      <span class="plugin-name">{{ plugin.name || plugin.id }}</span>
                      @if (plugin.version) {
                        <span class="plugin-version">v{{ plugin.version }}</span>
                      }
                      <span class="status-badge" [class.status-loaded]="plugin.status === 'installed'" [class.status-error]="plugin.status === 'missing'">
                        {{ plugin.status }}
                      </span>
                    </div>
                    @if (plugin.installPath) {
                      <p class="plugin-path">{{ plugin.installPath }}</p>
                    }
                    <div class="plugin-actions">
                      <button
                        class="btn small"
                        type="button"
                        [disabled]="runtimeWorking()"
                        (click)="updateRuntimePlugin(plugin.id)"
                      >Update</button>
                      <button
                        class="btn danger small"
                        type="button"
                        [disabled]="runtimeWorking()"
                        (click)="uninstallRuntimePlugin(plugin.id)"
                      >Uninstall</button>
                    </div>
                  </div>
                }
              </div>
            }
          </div>
        }

        <!-- Discover Tab -->
        @if (activeTab() === 'discover') {
          <div class="tab-content">
            <div class="discover-actions">
              <button
                class="btn primary"
                type="button"
                [disabled]="working()"
                (click)="discoverPlugins()"
              >{{ working() ? 'Discovering…' : 'Discover Plugins' }}</button>
            </div>

            @if (availablePlugins().length > 0) {
              <div class="plugin-grid">
                @for (plugin of availablePlugins(); track plugin.id) {
                  <div class="plugin-card">
                    <div class="plugin-card-header">
                      <span class="plugin-name">{{ plugin.name }}</span>
                      @if (plugin.version) {
                        <span class="plugin-version">v{{ plugin.version }}</span>
                      }
                    </div>
                    @if (plugin.description) {
                      <p class="plugin-description">{{ plugin.description }}</p>
                    }
                    @if (plugin.path) {
                      <p class="plugin-path">{{ plugin.path }}</p>
                    }
                    <div class="plugin-actions">
                      <button
                        class="btn primary small"
                        type="button"
                        [disabled]="working()"
                        (click)="installPlugin(plugin.path ?? plugin.id)"
                      >Install</button>
                    </div>
                  </div>
                }
              </div>
            } @else {
              <div class="empty-state">Click "Discover Plugins" to find available plugins.</div>
            }

            <!-- Install from Path -->
            <div class="install-from-path">
              <div class="section-title">Install from Path</div>
              <div class="install-row">
                <input
                  class="input"
                  type="text"
                  placeholder="/path/to/plugin"
                  [value]="installPath()"
                  (input)="onInstallPathInput($event)"
                />
                <button
                  class="btn primary"
                  type="button"
                  [disabled]="working() || installPath().trim().length === 0"
                  (click)="installFromPath()"
                >Install</button>
              </div>
            </div>

            <div class="install-from-path">
              <div class="section-title">Install Runtime Package</div>
              <div class="install-row">
                <input
                  class="input"
                  type="text"
                  placeholder="/path/to/plugin, /path/to/plugin.zip, or https://..."
                  [value]="runtimeSourceInput()"
                  (input)="onRuntimeSourceInput($event)"
                />
                <button
                  class="btn"
                  type="button"
                  [disabled]="runtimeWorking() || runtimeSourceInput().trim().length === 0"
                  (click)="validateRuntimeSource()"
                >Validate</button>
                <button
                  class="btn primary"
                  type="button"
                  [disabled]="runtimeWorking() || runtimeSourceInput().trim().length === 0"
                  (click)="installRuntimeSource()"
                >{{ runtimeWorking() ? 'Working…' : 'Install' }}</button>
              </div>
              @if (runtimeValidation(); as validation) {
                <div class="runtime-validation" [class.invalid]="!validation.ok">
                  @if (validation.ok) {
                    <span>{{ validation.manifest.name }} v{{ validation.manifest.version }}</span>
                    @if (validation.warnings.length > 0) {
                      <span>{{ validation.warnings.join(' ') }}</span>
                    }
                  } @else {
                    <span>{{ validation.errors.join(' ') }}</span>
                    @if (validation.warnings.length > 0) {
                      <span>{{ validation.warnings.join(' ') }}</span>
                    }
                  }
                </div>
              }
              @if (runtimeStatusMessage()) {
                <div class="template-result">{{ runtimeStatusMessage() }}</div>
              }
              <div class="discover-actions">
                <button
                  class="btn"
                  type="button"
                  [disabled]="runtimeWorking()"
                  (click)="pruneRuntimePlugins()"
                >Prune Stale Packages</button>
              </div>
            </div>
          </div>
        }
      </div>

      <!-- Create Template Panel -->
      <div class="panel create-template">
        <div class="panel-title">Create Plugin Template</div>
        <div class="create-row">
          <input
            class="input"
            type="text"
            placeholder="my-plugin"
            [value]="templateName()"
            (input)="onTemplateNameInput($event)"
          />
          <button
            class="btn primary"
            type="button"
            [disabled]="working() || templateName().trim().length === 0"
            (click)="createTemplate()"
          >Create Template</button>
        </div>
        @if (templateResult()) {
          <div class="template-result">{{ templateResult() }}</div>
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

    .page {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      gap: var(--spacing-md);
      padding: var(--spacing-lg);
      background: var(--bg-primary);
      color: var(--text-primary);
      overflow-y: auto;
    }

    /* ── Header ── */

    .page-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
    }

    .header-btn {
      padding: var(--spacing-xs) var(--spacing-md);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      cursor: pointer;
      font-size: 12px;
    }

    .header-title {
      flex: 1;
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
      gap: var(--spacing-sm);
    }

    /* ── Metrics ── */

    .metrics {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--spacing-md);
    }

    .metric-card {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: var(--spacing-md);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
    }

    .metric-label {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .metric-value {
      font-size: 24px;
      font-weight: 700;
      color: var(--text-primary);
    }

    /* ── Error Banner ── */

    .error-banner {
      padding: var(--spacing-sm) var(--spacing-md);
      border: 1px solid color-mix(in srgb, var(--error-color) 60%, transparent);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--error-color) 14%, transparent);
      color: var(--error-color);
      font-size: 12px;
    }

    /* ── Panel / Tabs ── */

    .panel {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      overflow: hidden;
    }

    .tab-bar {
      display: flex;
      border-bottom: 1px solid var(--border-color);
    }

    .tab {
      padding: var(--spacing-sm) var(--spacing-md);
      border: none;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 13px;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
    }

    .tab.active {
      color: var(--text-primary);
      border-bottom-color: var(--primary-color);
      font-weight: 600;
    }

    .tab-content {
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
    }

    /* ── Plugin Grid ── */

    .plugin-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: var(--spacing-md);
    }

    .plugin-card {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      padding: var(--spacing-md);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-tertiary);
    }

    .plugin-card-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      flex-wrap: wrap;
    }

    .plugin-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .plugin-version {
      font-size: 11px;
      color: var(--text-muted);
    }

    .status-badge {
      margin-left: auto;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
    }

    .status-loaded {
      background: color-mix(in srgb, var(--success-color, #22c55e) 20%, transparent);
      color: var(--success-color, #22c55e);
    }

    .status-unloaded {
      background: color-mix(in srgb, var(--text-muted) 20%, transparent);
      color: var(--text-muted);
    }

    .status-error {
      background: color-mix(in srgb, var(--error-color) 20%, transparent);
      color: var(--error-color);
    }

    .plugin-description {
      margin: 0;
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.4;
    }

    .plugin-path {
      margin: 0;
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--font-family-mono);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .plugin-actions {
      display: flex;
      gap: var(--spacing-xs);
      margin-top: var(--spacing-xs);
    }

    /* ── Discover Actions ── */

    .discover-actions {
      display: flex;
      gap: var(--spacing-sm);
    }

    /* ── Install from Path ── */

    .install-from-path {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      padding-top: var(--spacing-md);
      border-top: 1px solid var(--border-color);
    }

    .section-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .install-row,
    .create-row {
      display: flex;
      gap: var(--spacing-sm);
    }

    /* ── Create Template ── */

    .create-template {
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .panel-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .template-result {
      padding: var(--spacing-sm) var(--spacing-md);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-primary);
      font-size: 12px;
      color: var(--text-primary);
      font-family: var(--font-family-mono);
    }

    .runtime-validation {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm) var(--spacing-md);
      border: 1px solid color-mix(in srgb, var(--success-color, #22c55e) 50%, transparent);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--success-color, #22c55e) 12%, transparent);
      color: var(--text-primary);
      font-size: 12px;
    }

    .runtime-validation.invalid {
      border-color: color-mix(in srgb, var(--error-color) 60%, transparent);
      background: color-mix(in srgb, var(--error-color) 14%, transparent);
      color: var(--error-color);
    }

    /* ── Common ── */

    .empty-state {
      font-size: 13px;
      color: var(--text-muted);
      text-align: center;
      padding: var(--spacing-lg);
    }

    .input {
      flex: 1;
      min-width: 0;
      padding: var(--spacing-xs) var(--spacing-sm);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 13px;
    }

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

    .btn.primary {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: #fff;
    }

    .btn.danger {
      background: color-mix(in srgb, var(--error-color) 20%, transparent);
      border-color: color-mix(in srgb, var(--error-color) 60%, transparent);
      color: var(--error-color);
    }

    .btn.small {
      padding: 2px var(--spacing-sm);
      font-size: 12px;
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    @media (max-width: 640px) {
      .metrics {
        grid-template-columns: 1fr;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PluginsPageComponent implements OnInit, OnDestroy {
  private readonly router = inject(Router);
  private readonly pluginIpc = inject(PluginIpcService);

  // ── State signals ──────────────────────────────────────────────────────────

  readonly loadedPlugins = signal<PluginInfo[]>([]);
  readonly availablePlugins = signal<PluginInfo[]>([]);
  readonly runtimePlugins = signal<RuntimePluginInfo[]>([]);
  readonly activeTab = signal<ActiveTab>('installed');
  readonly loading = signal(false);
  readonly working = signal(false);
  readonly runtimeWorking = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly installPath = signal('');
  readonly runtimeSourceInput = signal('');
  readonly runtimeValidation = signal<RuntimeValidationResult | null>(null);
  readonly runtimeStatusMessage = signal<string | null>(null);
  readonly templateName = signal('');
  readonly templateResult = signal<string | null>(null);

  // ── Computed ───────────────────────────────────────────────────────────────

  readonly loadedCount = computed(() =>
    this.loadedPlugins().filter((p) => p.status === 'loaded').length
  );

  readonly availableCount = computed(() => this.availablePlugins().length);

  readonly installedCount = computed(() => this.loadedPlugins().length);

  readonly runtimePackageCount = computed(() =>
    this.runtimePlugins().filter((plugin) => plugin.status === 'installed').length
  );

  // ── Event unsubscribers ────────────────────────────────────────────────────

  private unsubLoaded: (() => void) | null = null;
  private unsubUnloaded: (() => void) | null = null;
  private unsubError: (() => void) | null = null;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async ngOnInit(): Promise<void> {
    this.subscribeToEvents();
    await this.refresh();
  }

  ngOnDestroy(): void {
    this.unsubLoaded?.();
    this.unsubUnloaded?.();
    this.unsubError?.();
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  goBack(): void {
    this.router.navigate(['/']);
  }

  // ── Tab ────────────────────────────────────────────────────────────────────

  setTab(tab: ActiveTab): void {
    this.activeTab.set(tab);
  }

  // ── Data loading ───────────────────────────────────────────────────────────

  async refresh(): Promise<void> {
    if (this.loading()) return;

    this.errorMessage.set(null);
    this.loading.set(true);
    try {
      const [loadedResponse, availableResponse] = await Promise.all([
        this.pluginIpc.pluginsGetLoaded(),
        this.pluginIpc.pluginsDiscover(),
      ]);

      if (!loadedResponse.success) {
        this.setError(loadedResponse, 'Failed to load plugins list.');
      } else {
        const loaded = this.extractData<PluginInfo[]>(loadedResponse) ?? [];
        this.loadedPlugins.set(loaded);
      }

      if (availableResponse.success) {
        const available = this.extractData<PluginInfo[]>(availableResponse) ?? [];
        this.availablePlugins.set(available);
      }

      await this.refreshRuntimePlugins();
    } finally {
      this.loading.set(false);
    }
  }

  async discoverPlugins(): Promise<void> {
    if (this.working()) return;

    this.errorMessage.set(null);
    this.working.set(true);
    try {
      const response = await this.pluginIpc.pluginsDiscover();
      if (!response.success) {
        this.setError(response, 'Failed to discover plugins.');
        return;
      }
      const available = this.extractData<PluginInfo[]>(response) ?? [];
      this.availablePlugins.set(available);
    } finally {
      this.working.set(false);
    }
  }

  // ── Plugin operations ──────────────────────────────────────────────────────

  async loadPlugin(pluginId: string): Promise<void> {
    if (this.working()) return;

    this.errorMessage.set(null);
    this.working.set(true);
    try {
      const response = await this.pluginIpc.pluginsLoad(pluginId);
      if (!response.success) {
        this.setError(response, `Failed to load plugin "${pluginId}".`);
        return;
      }
      await this.refreshLoaded();
    } finally {
      this.working.set(false);
    }
  }

  async unloadPlugin(pluginId: string): Promise<void> {
    if (this.working()) return;

    this.errorMessage.set(null);
    this.working.set(true);
    try {
      const response = await this.pluginIpc.pluginsUnload(pluginId);
      if (!response.success) {
        this.setError(response, `Failed to unload plugin "${pluginId}".`);
        return;
      }
      await this.refreshLoaded();
    } finally {
      this.working.set(false);
    }
  }

  async installPlugin(sourcePath: string): Promise<void> {
    if (this.working()) return;

    this.errorMessage.set(null);
    this.working.set(true);
    try {
      const response = await this.pluginIpc.pluginsInstall(sourcePath);
      if (!response.success) {
        this.setError(response, `Failed to install plugin from "${sourcePath}".`);
        return;
      }
      await this.refresh();
    } finally {
      this.working.set(false);
    }
  }

  async installFromPath(): Promise<void> {
    const path = this.installPath().trim();
    if (!path) return;
    await this.installPlugin(path);
    if (!this.errorMessage()) {
      this.installPath.set('');
    }
  }

  async uninstallPlugin(pluginId: string): Promise<void> {
    if (this.working()) return;

    this.errorMessage.set(null);
    this.working.set(true);
    try {
      const response = await this.pluginIpc.pluginsUninstall(pluginId);
      if (!response.success) {
        this.setError(response, `Failed to uninstall plugin "${pluginId}".`);
        return;
      }
      await this.refresh();
    } finally {
      this.working.set(false);
    }
  }

  async validateRuntimeSource(): Promise<void> {
    if (this.runtimeWorking()) return;
    const source = this.getRuntimePackageSource();
    if (!source) return;

    this.errorMessage.set(null);
    this.runtimeStatusMessage.set(null);
    this.runtimeWorking.set(true);
    try {
      const response = await this.pluginIpc.runtimePluginsValidate(source);
      if (!response.success) {
        this.setError(response, 'Failed to validate runtime plugin package.');
        return;
      }
      this.runtimeValidation.set(this.extractData<RuntimeValidationResult>(response));
    } finally {
      this.runtimeWorking.set(false);
    }
  }

  async installRuntimeSource(): Promise<void> {
    if (this.runtimeWorking()) return;
    const source = this.getRuntimePackageSource();
    if (!source) return;

    this.errorMessage.set(null);
    this.runtimeStatusMessage.set(null);
    this.runtimeWorking.set(true);
    try {
      const response = await this.pluginIpc.runtimePluginsInstall(source);
      if (!response.success) {
        this.setError(response, 'Failed to install runtime plugin package.');
        return;
      }
      const installed = this.extractData<RuntimePluginInfo>(response);
      this.runtimeStatusMessage.set(installed ? `Installed ${installed.name || installed.id}` : 'Runtime package installed.');
      this.runtimeSourceInput.set('');
      this.runtimeValidation.set(null);
      await this.refreshRuntimePlugins();
    } finally {
      this.runtimeWorking.set(false);
    }
  }

  async updateRuntimePlugin(pluginId: string): Promise<void> {
    if (this.runtimeWorking()) return;

    this.errorMessage.set(null);
    this.runtimeStatusMessage.set(null);
    this.runtimeWorking.set(true);
    try {
      const response = await this.pluginIpc.runtimePluginsUpdate(pluginId, undefined);
      if (!response.success) {
        this.setError(response, `Failed to update runtime plugin "${pluginId}".`);
        return;
      }
      this.runtimeStatusMessage.set(`Updated ${pluginId}`);
      await this.refreshRuntimePlugins();
    } finally {
      this.runtimeWorking.set(false);
    }
  }

  async pruneRuntimePlugins(): Promise<void> {
    if (this.runtimeWorking()) return;

    this.errorMessage.set(null);
    this.runtimeStatusMessage.set(null);
    this.runtimeWorking.set(true);
    try {
      const response = await this.pluginIpc.runtimePluginsPrune();
      if (!response.success) {
        this.setError(response, 'Failed to prune runtime plugin packages.');
        return;
      }
      const result = this.extractData<{ removed: string[] }>(response);
      this.runtimeStatusMessage.set(`Pruned ${result?.removed.length ?? 0} package(s).`);
      await this.refreshRuntimePlugins();
    } finally {
      this.runtimeWorking.set(false);
    }
  }

  async uninstallRuntimePlugin(pluginId: string): Promise<void> {
    if (this.runtimeWorking()) return;

    this.errorMessage.set(null);
    this.runtimeStatusMessage.set(null);
    this.runtimeWorking.set(true);
    try {
      const response = await this.pluginIpc.runtimePluginsUninstall(pluginId);
      if (!response.success) {
        this.setError(response, `Failed to uninstall runtime plugin "${pluginId}".`);
        return;
      }
      this.runtimeStatusMessage.set(`Uninstalled ${pluginId}`);
      await this.refreshRuntimePlugins();
    } finally {
      this.runtimeWorking.set(false);
    }
  }

  async createTemplate(): Promise<void> {
    const name = this.templateName().trim();
    if (!name || this.working()) return;

    this.errorMessage.set(null);
    this.templateResult.set(null);
    this.working.set(true);
    try {
      const response = await this.pluginIpc.pluginsCreateTemplate(name);
      if (!response.success) {
        this.setError(response, `Failed to create plugin template "${name}".`);
        return;
      }
      const result = this.extractData<string>(response) ?? `Template "${name}" created successfully.`;
      this.templateResult.set(result);
      this.templateName.set('');
    } finally {
      this.working.set(false);
    }
  }

  // ── Input handlers ─────────────────────────────────────────────────────────

  onInstallPathInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.installPath.set(target.value);
  }

  onRuntimeSourceInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.runtimeSourceInput.set(target.value);
    this.runtimeValidation.set(null);
    this.runtimeStatusMessage.set(null);
  }

  onTemplateNameInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.templateName.set(target.value);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async refreshLoaded(): Promise<void> {
    const response = await this.pluginIpc.pluginsGetLoaded();
    if (response.success) {
      const loaded = this.extractData<PluginInfo[]>(response) ?? [];
      this.loadedPlugins.set(loaded);
    }
  }

  private async refreshRuntimePlugins(): Promise<void> {
    const response = await this.pluginIpc.runtimePluginsList();
    if (response.success) {
      const runtimePlugins = this.extractData<RuntimePluginInfo[]>(response) ?? [];
      this.runtimePlugins.set(runtimePlugins);
    }
  }

  private subscribeToEvents(): void {
    this.unsubLoaded = this.pluginIpc.onPluginLoaded(() => {
      void this.refreshLoaded();
    });

    this.unsubUnloaded = this.pluginIpc.onPluginUnloaded(() => {
      void this.refreshLoaded();
    });

    this.unsubError = this.pluginIpc.onPluginError((data) => {
      this.errorMessage.set(`Plugin error (${data.pluginId}): ${data.error}`);
    });
  }

  private setError(response: IpcResponse, fallback: string): void {
    this.errorMessage.set(response.error?.message ?? fallback);
  }

  private extractData<T>(response: IpcResponse): T | null {
    return response.success ? (response.data as T) : null;
  }

  private getRuntimePackageSource(): PluginPackageSource | null {
    const value = this.runtimeSourceInput().trim();
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) {
      return { type: 'url', value };
    }
    if (value.toLowerCase().endsWith('.zip')) {
      return { type: 'zip', value };
    }
    if (/\.(mjs|cjs|js)$/i.test(value)) {
      return { type: 'file', value };
    }
    return { type: 'directory', value };
  }
}
