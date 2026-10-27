/**
 * Plugins Page
 * Runtime plugin packages: install, update, remove, and project plugin trust.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { PluginIpcService } from '../../core/services/ipc/plugin-ipc.service';
import { InstanceStore } from '../../core/state/instance/instance.store';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import type { PluginPackageSource } from '@contracts/schemas/plugin';

// ─── Local interfaces ─────────────────────────────────────────────────────────

type RuntimePluginStatus = 'installed' | 'missing' | 'disabled' | 'broken';

interface RuntimePluginInfo {
  id: string;
  name: string;
  version?: string;
  status: RuntimePluginStatus;
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

type ProjectPluginTrust = 'trusted' | 'untrusted' | 'ask';

interface ProjectPluginTrustDecision {
  projectRoot: string;
  trust: ProjectPluginTrust;
}

// The template shows a badge only for a package that needs attention.
const PACKAGE_STATUS_LABELS: Record<RuntimePluginStatus, string> = {
  installed: 'Installed',
  missing: 'Files missing',
  disabled: 'Turned off',
  broken: "Can't load",
};

const TRUST_PRESENTATION: Record<ProjectPluginTrust, { label: string; explanation: string }> = {
  trusted: { label: 'Trusted', explanation: 'Plugins in this folder run.' },
  untrusted: { label: 'Blocked', explanation: 'Plugins in this folder are blocked.' },
  ask: { label: 'Not decided', explanation: "Plugins in this folder don't run until you trust it." },
};

// ─── Component ────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-plugins-page',
  standalone: true,
  template: `
    <div class="page">

      <div class="page-header">
        <div class="header-title">
          <span class="title">Plugins</span>
          <span class="subtitle">
            Packages that react to what happens in Harness, such as sessions starting,
            messages, automations and file edits. They can send notifications or record activity.
          </span>
        </div>
        <div class="header-actions">
          <button class="btn" type="button" [disabled]="loading()" (click)="refresh()">
            {{ loading() ? 'Refreshing…' : 'Refresh' }}
          </button>
        </div>
      </div>

      @if (errorMessage()) {
        <div class="error-banner" role="alert">
          {{ errorMessage() }}
          @if (errorDetail()) {
            <details class="error-detail">
              <summary>Details</summary>
              {{ errorDetail() }}
            </details>
          }
        </div>
      }

      <section class="panel">
        <div class="section-title">Installed packages</div>
        <p class="section-desc">
          Installed into <code>~/.orchestrator/plugins</code>. A package is active as soon as it is installed.
          Uninstall deletes the package's files. Update installs it again from where it came from.
        </p>
        <!-- Until the list loads there is nothing to show; a failure shows in the error banner. -->
        @if (packagesLoaded()) {
          @if (runtimePlugins().length === 0) {
            <div class="empty-state">No packages installed.</div>
          } @else {
            <div class="plugin-grid">
              @for (plugin of runtimePlugins(); track plugin.id) {
                <div class="plugin-card">
                  <div class="plugin-card-header">
                    <span class="plugin-name">{{ plugin.name || plugin.id }}</span>
                    @if (plugin.version) {
                      <span class="plugin-version">v{{ plugin.version }}</span>
                    }
                    @if (plugin.status !== 'installed') {
                      <span class="status-badge status-error">{{ packageStatusLabel(plugin.status) }}</span>
                    }
                  </div>
                  <div class="plugin-actions">
                    <button
                      class="btn small"
                      type="button"
                      [disabled]="runtimeWorking()"
                      [attr.aria-label]="'Update ' + (plugin.name || plugin.id)"
                      (click)="updateRuntimePlugin(plugin.id)"
                    >Update</button>
                    <button
                      class="btn danger small"
                      type="button"
                      [disabled]="runtimeWorking()"
                      [attr.aria-label]="'Uninstall ' + (plugin.name || plugin.id)"
                      (click)="uninstallRuntimePlugin(plugin.id)"
                    >Uninstall</button>
                  </div>
                </div>
              }
            </div>
          }
        }
      </section>

      <section class="panel">
        <div class="section-title">Install a package</div>
        <p class="section-desc">From a folder, a .js file, a .zip file or a web address.</p>
        <div class="install-row">
          <input
            class="input"
            type="text"
            aria-label="Package location"
            placeholder="/path/to/plugin, /path/to/plugin.zip, or https://..."
            [value]="runtimeSourceInput()"
            (input)="onRuntimeSourceInput($event)"
          />
          <button
            class="btn"
            type="button"
            [disabled]="runtimeWorking() || runtimeSourceInput().trim().length === 0"
            (click)="validateRuntimeSource()"
          >Check</button>
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
              <span>Ready to install: {{ validation.manifest.name }} v{{ validation.manifest.version }}</span>
            } @else {
              <span>This package can't be installed:</span>
              @for (error of validation.errors; track $index) {
                <span>{{ error }}</span>
              }
            }
            @for (warning of validation.warnings; track $index) {
              <span>{{ warning }}</span>
            }
          </div>
        }
        @if (runtimeStatusMessage()) {
          <div class="status-message" role="status">{{ runtimeStatusMessage() }}</div>
        }
        <div class="prune-row">
          <button
            class="btn small"
            type="button"
            [disabled]="runtimeWorking()"
            (click)="pruneRuntimePlugins()"
          >Remove packages that aren't working</button>
          <span class="section-desc">Deletes every package whose files are missing or that can't load.</span>
        </div>
      </section>

      <section class="panel">
        <div class="project-trust-heading">
          <span class="section-title">Project plugin trust</span>
          @if (projectTrustWorkingDirectory()) {
            <span class="project-trust-workspace">{{ projectTrustWorkingDirectory() }}</span>
          }
        </div>
        <p class="section-desc">
          Plugins stored in a project's <code>.orchestrator/plugins</code> folder only run once you trust it.
          Each folder below, from this session's folder up to the project root, is one place they can live.
        </p>
        @if (!projectTrustWorkingDirectory()) {
          <p class="section-desc">Select a session with a project folder to review its plugins.</p>
        } @else {
          <div class="trust-list">
            @for (decision of projectPluginTrustDecisions(); track decision.projectRoot) {
              <div class="trust-row">
                <div class="trust-main">
                  <span class="plugin-path">{{ decision.projectRoot }}</span>
                  <span class="section-desc">{{ trustExplanation(decision.trust) }}</span>
                </div>
                <span class="status-badge" [class]="'status-' + decision.trust">
                  {{ trustLabel(decision.trust) }}
                </span>
                <div class="plugin-actions">
                  @if (decision.trust !== 'trusted') {
                    <button
                      class="btn primary small"
                      type="button"
                      [disabled]="projectTrustWorking()"
                      [attr.aria-label]="'Grant trust to ' + decision.projectRoot"
                      (click)="grantProjectPluginTrust(decision.projectRoot)"
                    >Grant trust</button>
                  }
                  @if (decision.trust !== 'untrusted') {
                    <button
                      class="btn danger small"
                      type="button"
                      [disabled]="projectTrustWorking()"
                      [attr.aria-label]="'Block ' + decision.projectRoot"
                      (click)="revokeProjectPluginTrust(decision.projectRoot)"
                    >Block</button>
                  }
                </div>
              </div>
            }
          </div>
        }
      </section>

    </div>
  `,
  styleUrl: './plugins-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PluginsPageComponent implements OnInit {
  private readonly pluginIpc = inject(PluginIpcService);
  private readonly instanceStore = inject(InstanceStore);

  // ── State signals ──────────────────────────────────────────────────────────

  readonly runtimePlugins = signal<RuntimePluginInfo[]>([]);
  readonly packagesLoaded = signal(false);
  readonly projectPluginTrustDecisions = signal<ProjectPluginTrustDecision[]>([]);
  readonly loading = signal(false);
  readonly runtimeWorking = signal(false);
  readonly projectTrustWorking = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly errorDetail = signal<string | null>(null);
  readonly runtimeSourceInput = signal('');
  readonly runtimeValidation = signal<RuntimeValidationResult | null>(null);
  readonly runtimeStatusMessage = signal<string | null>(null);

  // ── Computed ───────────────────────────────────────────────────────────────

  readonly projectTrustWorkingDirectory = computed(() => {
    const workingDirectory = this.instanceStore.selectedInstance()?.workingDirectory?.trim();
    return workingDirectory && workingDirectory.length > 0 ? workingDirectory : null;
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  // ── Data loading ───────────────────────────────────────────────────────────

  async refresh(): Promise<void> {
    if (this.loading()) return;

    this.clearError();
    this.loading.set(true);
    try {
      // Each section refreshes independently — a failure in one (e.g. a
      // backend error) must not prevent the other from loading.
      await Promise.allSettled([
        this.refreshRuntimePlugins(),
        this.refreshProjectPluginTrust(),
      ]);
    } finally {
      this.loading.set(false);
    }
  }

  // ── Runtime package operations ─────────────────────────────────────────────

  async validateRuntimeSource(): Promise<void> {
    if (this.runtimeWorking()) return;
    const source = this.getRuntimePackageSource();
    if (!source) return;

    this.clearError();
    this.runtimeStatusMessage.set(null);
    this.runtimeWorking.set(true);
    try {
      const response = await this.pluginIpc.runtimePluginsValidate(source);
      if (!response.success) {
        this.setError(response, "Couldn't check that package.");
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

    this.clearError();
    this.runtimeStatusMessage.set(null);
    this.runtimeWorking.set(true);
    try {
      const response = await this.pluginIpc.runtimePluginsInstall(source);
      if (!response.success) {
        this.setError(response, "Couldn't install that package.");
        return;
      }
      const installed = this.extractData<RuntimePluginInfo>(response);
      this.runtimeStatusMessage.set(installed ? `Installed ${installed.name || installed.id}.` : 'Package installed.');
      this.runtimeSourceInput.set('');
      this.runtimeValidation.set(null);
      await this.refreshRuntimePlugins();
    } finally {
      this.runtimeWorking.set(false);
    }
  }

  async updateRuntimePlugin(pluginId: string): Promise<void> {
    if (this.runtimeWorking()) return;

    this.clearError();
    this.runtimeStatusMessage.set(null);
    this.runtimeWorking.set(true);
    try {
      const response = await this.pluginIpc.runtimePluginsUpdate(pluginId, undefined);
      if (!response.success) {
        this.setError(response, `Couldn't update ${this.packageName(pluginId)}.`);
        return;
      }
      this.runtimeStatusMessage.set(`Updated ${this.packageName(pluginId)}.`);
      await this.refreshRuntimePlugins();
    } finally {
      this.runtimeWorking.set(false);
    }
  }

  async pruneRuntimePlugins(): Promise<void> {
    if (this.runtimeWorking()) return;

    this.clearError();
    this.runtimeStatusMessage.set(null);
    this.runtimeWorking.set(true);
    try {
      const response = await this.pluginIpc.runtimePluginsPrune();
      if (!response.success) {
        this.setError(response, "Couldn't remove packages that aren't working.");
        return;
      }
      const removed = this.extractData<{ removed: string[] }>(response)?.removed.length ?? 0;
      this.runtimeStatusMessage.set(
        removed === 0 ? 'Every package is working; nothing removed.' : `Removed ${removed} package${removed === 1 ? '' : 's'}.`,
      );
      await this.refreshRuntimePlugins();
    } finally {
      this.runtimeWorking.set(false);
    }
  }

  async uninstallRuntimePlugin(pluginId: string): Promise<void> {
    if (this.runtimeWorking()) return;
    const name = this.packageName(pluginId);

    this.clearError();
    this.runtimeStatusMessage.set(null);
    this.runtimeWorking.set(true);
    try {
      const response = await this.pluginIpc.runtimePluginsUninstall(pluginId);
      if (!response.success) {
        this.setError(response, `Couldn't uninstall ${name}.`);
        return;
      }
      this.runtimeStatusMessage.set(`Uninstalled ${name}.`);
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

  // ── Labels ─────────────────────────────────────────────────────────────────

  packageStatusLabel(status: RuntimePluginStatus): string {
    return PACKAGE_STATUS_LABELS[status];
  }

  trustLabel(trust: ProjectPluginTrust): string {
    return TRUST_PRESENTATION[trust].label;
  }

  trustExplanation(trust: ProjectPluginTrust): string {
    return TRUST_PRESENTATION[trust].explanation;
  }

  // ── Input handlers ─────────────────────────────────────────────────────────

  onRuntimeSourceInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.runtimeSourceInput.set(target.value);
    this.runtimeValidation.set(null);
    this.runtimeStatusMessage.set(null);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async refreshRuntimePlugins(): Promise<void> {
    try {
      const response = await this.pluginIpc.runtimePluginsList();
      if (response.success) {
        this.runtimePlugins.set(this.extractData<RuntimePluginInfo[]>(response) ?? []);
        this.packagesLoaded.set(true);
      } else {
        this.setError(response, "Couldn't read the installed packages.");
      }
    } catch {
      this.showError("Couldn't read the installed packages.");
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
        this.setError(response, "Couldn't read plugin trust for this project.");
      }
    } catch {
      this.showError("Couldn't read plugin trust for this project.");
    }
  }

  private async updateProjectPluginTrust(projectRoot: string, action: 'grant' | 'revoke'): Promise<void> {
    if (this.projectTrustWorking()) return;

    this.clearError();
    this.projectTrustWorking.set(true);
    try {
      const response = action === 'grant'
        ? await this.pluginIpc.projectPluginTrustGrant(projectRoot)
        : await this.pluginIpc.projectPluginTrustRevoke(projectRoot);
      if (!response.success) {
        this.setError(
          response,
          action === 'grant'
            ? `Couldn't trust the plugins in ${projectRoot}.`
            : `Couldn't block the plugins in ${projectRoot}.`,
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

  private packageName(pluginId: string): string {
    const plugin = this.runtimePlugins().find((item) => item.id === pluginId);
    return plugin?.name || pluginId;
  }

  // The plain sentence says what failed; the main process's own message sits behind Details.
  private setError(response: IpcResponse, message: string): void {
    this.showError(message, response.error?.message);
  }

  private showError(message: string, detail?: string): void {
    this.errorMessage.set(message);
    this.errorDetail.set(detail ?? null);
  }

  private clearError(): void {
    this.errorMessage.set(null);
    this.errorDetail.set(null);
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
