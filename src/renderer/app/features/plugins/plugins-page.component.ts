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
import { PluginIpcService } from '../../core/services/ipc/plugin-ipc.service';
import { InstanceStore } from '../../core/state/instance/instance.store';
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
  status: 'installed' | 'missing' | 'disabled' | 'broken';
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

type ProjectPluginTrust = 'trusted' | 'untrusted' | 'ask';

interface ProjectPluginTrustDecision {
  projectRoot: string;
  trust: ProjectPluginTrust;
  reason: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-plugins-page',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="page">

      <!-- Page Header -->
      <div class="page-header">
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

      <!-- What are plugins? -->
      <div class="panel info-panel">
        <div class="info-block">
          <span class="info-title">Provider Plugins</span>
          <p class="info-text">
            Add a custom AI provider — a new model backend alongside Claude,
            Gemini, Codex, and Copilot. Each is a JavaScript file that implements
            a provider interface (initialize, send message, list models). Use
            <strong>Create Plugin Template</strong> below to scaffold one, then
            load it from the <strong>Installed</strong> tab.
          </p>
        </div>
        <div class="info-block">
          <span class="info-title">Runtime Plugin Packages</span>
          <p class="info-text">
            Event-driven extensions that observe and react to the orchestrator
            — notifications, telemetry, audit logging, custom automation —
            through lifecycle hooks. Install a package from a folder, .zip, or
            URL in the <strong>Discover</strong> tab.
          </p>
        </div>
      </div>

      <!-- Metric Cards -->
      <div class="metrics">
        <div
          class="metric-card"
          title="Provider plugins currently loaded into memory and usable as a model backend"
        >
          <span class="metric-label">Loaded Plugins</span>
          <span class="metric-value">{{ loadedCount() }}</span>
        </div>
        <div
          class="metric-card"
          title="Provider plugins discovered on disk via the Discover tab"
        >
          <span class="metric-label">Available</span>
          <span class="metric-value">{{ availableCount() }}</span>
        </div>
        <div
          class="metric-card"
          title="Provider plugin files installed in your app data folder"
        >
          <span class="metric-label">Installed</span>
          <span class="metric-value">{{ installedCount() }}</span>
        </div>
        <div
          class="metric-card"
          title="Runtime plugin packages installed and active"
        >
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
            <p class="section-desc">
              Custom AI providers installed in your app data folder. Load one to
              make it usable as a model backend.
            </p>
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
            <p class="section-desc">
              Hook/event plugins installed into <code>~/.orchestrator/plugins</code>.
              Active automatically while installed — no manual load step.
            </p>
            <div class="project-trust-panel">
              <div class="project-trust-heading">
                <span class="section-title">Project Plugin Trust</span>
                @if (projectTrustWorkingDirectory()) {
                  <span class="project-trust-workspace">{{ projectTrustWorkingDirectory() }}</span>
                }
              </div>
              @if (!projectTrustWorkingDirectory()) {
                <p class="section-desc">
                  Select a workspace-backed instance to review project-scoped plugin trust.
                </p>
              } @else if (projectPluginTrustDecisions().length === 0) {
                <p class="section-desc">No project plugin roots were found for this workspace.</p>
              } @else {
                <div class="trust-list">
                  @for (decision of projectPluginTrustDecisions(); track decision.projectRoot) {
                    <div class="trust-row">
                      <div class="trust-main">
                        <span class="plugin-path">{{ decision.projectRoot }}</span>
                        <span class="section-desc">{{ decision.reason }}</span>
                      </div>
                      <span class="status-badge" [class]="'status-' + decision.trust">
                        {{ decision.trust }}
                      </span>
                      <div class="plugin-actions">
                        @if (decision.trust !== 'trusted') {
                          <button
                            class="btn primary small"
                            type="button"
                            [disabled]="projectTrustWorking()"
                            (click)="grantProjectPluginTrust(decision.projectRoot)"
                          >Grant trust</button>
                        }
                        @if (decision.trust !== 'untrusted') {
                          <button
                            class="btn danger small"
                            type="button"
                            [disabled]="projectTrustWorking()"
                            (click)="revokeProjectPluginTrust(decision.projectRoot)"
                          >Reject</button>
                        }
                      </div>
                    </div>
                  }
                </div>
              }
            </div>
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
                      <span class="status-badge" [class.status-loaded]="plugin.status === 'installed'" [class.status-error]="plugin.status !== 'installed'">
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
        <p class="section-desc">
          Scaffolds a new Provider Plugin (custom AI provider) as a JavaScript
          file in your app data folder, ready to edit.
        </p>
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
  styleUrl: './plugins-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PluginsPageComponent implements OnInit, OnDestroy {
  private readonly pluginIpc = inject(PluginIpcService);
  private readonly instanceStore = inject(InstanceStore);

  // ── State signals ──────────────────────────────────────────────────────────

  readonly loadedPlugins = signal<PluginInfo[]>([]);
  readonly availablePlugins = signal<PluginInfo[]>([]);
  readonly runtimePlugins = signal<RuntimePluginInfo[]>([]);
  readonly projectPluginTrustDecisions = signal<ProjectPluginTrustDecision[]>([]);
  readonly activeTab = signal<ActiveTab>('installed');
  readonly loading = signal(false);
  readonly working = signal(false);
  readonly runtimeWorking = signal(false);
  readonly projectTrustWorking = signal(false);
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

  readonly projectTrustWorkingDirectory = computed(() => {
    const workingDirectory = this.instanceStore.selectedInstance()?.workingDirectory?.trim();
    return workingDirectory && workingDirectory.length > 0 ? workingDirectory : null;
  });

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
      // Each section refreshes independently — a failure in one (e.g. a
      // backend error) must not prevent the others from loading.
      await Promise.allSettled([
        this.refreshLoaded(),
        this.refreshAvailable(),
        this.refreshRuntimePlugins(),
        this.refreshProjectPluginTrust(),
      ]);
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

  async grantProjectPluginTrust(projectRoot: string): Promise<void> {
    await this.updateProjectPluginTrust(projectRoot, 'grant');
  }

  async revokeProjectPluginTrust(projectRoot: string): Promise<void> {
    await this.updateProjectPluginTrust(projectRoot, 'revoke');
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
      const data = this.extractData<{ filePath: string }>(response);
      this.templateResult.set(
        data?.filePath
          ? `Created provider plugin template at ${data.filePath}`
          : `Template "${name}" created successfully.`,
      );
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
    try {
      const response = await this.pluginIpc.pluginsGetLoaded();
      if (response.success) {
        this.loadedPlugins.set(this.extractData<PluginInfo[]>(response) ?? []);
      } else {
        this.setError(response, 'Failed to load plugins list.');
      }
    } catch {
      this.errorMessage.set('Failed to load plugins list.');
    }
  }

  private async refreshAvailable(): Promise<void> {
    try {
      const response = await this.pluginIpc.pluginsDiscover();
      if (response.success) {
        this.availablePlugins.set(this.extractData<PluginInfo[]>(response) ?? []);
      }
    } catch {
      // Discovery is best-effort; keep the existing list on failure.
    }
  }

  private async refreshRuntimePlugins(): Promise<void> {
    try {
      const response = await this.pluginIpc.runtimePluginsList();
      if (response.success) {
        this.runtimePlugins.set(this.extractData<RuntimePluginInfo[]>(response) ?? []);
      }
    } catch {
      // Runtime package listing is best-effort; keep the existing list.
    }
  }

  private async refreshProjectPluginTrust(): Promise<void> {
    const workingDirectory = this.projectTrustWorkingDirectory();
    if (!workingDirectory) {
      this.projectPluginTrustDecisions.set([]);
      return;
    }

    try {
      const response = await this.pluginIpc.projectPluginTrustQuery(workingDirectory);
      if (response.success) {
        const data = this.extractData<{ decisions: ProjectPluginTrustDecision[] }>(response);
        this.projectPluginTrustDecisions.set(data?.decisions ?? []);
      } else {
        this.setError(response, 'Failed to query project plugin trust.');
      }
    } catch {
      this.errorMessage.set('Failed to query project plugin trust.');
    }
  }

  private async updateProjectPluginTrust(projectRoot: string, action: 'grant' | 'revoke'): Promise<void> {
    if (this.projectTrustWorking()) return;

    this.errorMessage.set(null);
    this.projectTrustWorking.set(true);
    try {
      const response = action === 'grant'
        ? await this.pluginIpc.projectPluginTrustGrant(projectRoot)
        : await this.pluginIpc.projectPluginTrustRevoke(projectRoot);
      if (!response.success) {
        this.setError(
          response,
          action === 'grant'
            ? `Failed to trust project plugins at "${projectRoot}".`
            : `Failed to reject project plugins at "${projectRoot}".`,
        );
        return;
      }
      const decision = this.extractData<ProjectPluginTrustDecision>(response);
      if (decision) {
        this.projectPluginTrustDecisions.update((decisions) =>
          decisions.map((item) => item.projectRoot === decision.projectRoot ? decision : item)
        );
      }
      await this.refreshProjectPluginTrust();
      await this.refreshRuntimePlugins();
    } finally {
      this.projectTrustWorking.set(false);
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
