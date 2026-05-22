/**
 * CLI Health Settings Tab
 *
 * Surfaces the state of each installed AI CLI: which binary is active, which
 * version, and whether shadow installs (multiple copies at different PATH
 * locations with different versions) are silently shadowing the current one.
 *
 * Feeds from the main-process `cli:diagnose-all` IPC, which combines
 * `scanAllCliInstalls` with the `ProviderDoctor` probe suite.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { ProviderIpcService } from '../../core/services/ipc/provider-ipc.service';

interface CliInstall {
  path: string;
  version?: string;
  installed: boolean;
  error?: string;
}

interface ProbeResult {
  name: string;
  status: 'pass' | 'fail' | 'skip' | 'timeout';
  message: string;
  latencyMs: number;
  metadata?: Record<string, unknown>;
}

interface CliDiagnosisEntry {
  cli: string;
  installs: CliInstall[];
  activePath?: string;
  activeVersion?: string;
  diagnosis: {
    provider: string;
    probes: ProbeResult[];
    overall: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
    recommendations: string[];
  } | null;
  updatePlan?: CliUpdatePlan;
}

type Severity = 'healthy' | 'warning' | 'error' | 'missing';

interface CliUpdatePlan {
  cli: string;
  displayName: string;
  supported: boolean;
  command?: string;
  args?: string[];
  displayCommand?: string;
  activePath?: string;
  currentVersion?: string;
  reason?: string;
}

interface CliUpdateResult {
  cli: string;
  displayName: string;
  status: 'updated' | 'failed' | 'skipped';
  message: string;
  command?: string;
  beforeVersion?: string;
  afterVersion?: string;
  stdout?: string;
  stderr?: string;
  durationMs: number;
}

@Component({
  standalone: true,
  selector: 'app-cli-health-settings-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cli-health-tab">
      <div class="tab-header">
        <div>
          <h3 class="section-title">CLI Health</h3>
          <p class="section-desc">
            Which AI CLIs are installed, what versions they report, and whether
            any stale duplicate copies are hiding behind them on PATH.
          </p>
        </div>
        <div class="header-actions">
          <button
            type="button"
            class="btn btn-secondary"
            (click)="updateAll()"
            [disabled]="loading() || anyUpdating()"
          >
            {{ anyUpdating() ? 'Running updaters...' : 'Run installed CLI updaters' }}
          </button>
          <button
            type="button"
            class="btn btn-secondary"
            (click)="refresh()"
            [disabled]="loading() || anyUpdating()"
          >
            {{ loading() ? 'Scanning...' : 'Refresh' }}
          </button>
        </div>
      </div>

      @if (error()) {
        <div class="error-banner">{{ error() }}</div>
      }

      @if (updateSummary()) {
        <div class="update-summary">{{ updateSummary() }}</div>
      }

      @if (entries().length === 0 && !loading()) {
        <p class="empty">No CLIs scanned yet.</p>
      }

      @for (entry of entries(); track entry.cli) {
        <div class="cli-card" [attr.data-severity]="severity(entry)">
          <div class="cli-card-head">
            <div class="cli-name-block">
              <span class="cli-name">{{ cliDisplayName(entry.cli) }}</span>
              <span class="cli-badge" [attr.data-severity]="severity(entry)">
                {{ severityLabel(severity(entry)) }}
              </span>
            </div>
            <div class="card-actions">
              @if (entry.updatePlan?.supported) {
                <button
                  type="button"
                  class="btn-link"
                  (click)="updateCli(entry.cli)"
                  [disabled]="isUpdating(entry.cli) || loading()"
                >
                  {{ isUpdating(entry.cli) ? 'Running...' : 'Run updater' }}
                </button>
              }
              @if (entry.installs.length > 0) {
                <button
                  type="button"
                  class="btn-link"
                  (click)="toggle(entry.cli)"
                >
                  {{ expanded().has(entry.cli) ? 'Hide details' : 'Show details' }}
                </button>
              }
            </div>
          </div>

          @if (updateResultFor(entry.cli); as result) {
            <div class="update-result" [attr.data-status]="result.status">
              <strong>{{ updateStatusLabel(result.status) }}:</strong>
              {{ result.message }}
              @if (result.command) {
                <span class="muted">({{ result.command }})</span>
              }
            </div>
          }

          @if (entry.updatePlan && !entry.updatePlan.supported && entry.installs.length > 0) {
            <p class="muted update-reason">{{ entry.updatePlan.reason }}</p>
          }

          @if (entry.installs.length === 0) {
            <p class="muted">Not installed on PATH.</p>
          } @else {
            <div class="active-row">
              <span class="label">Active:</span>
              <code class="path">{{ entry.activePath }}</code>
              <span class="version">v{{ entry.activeVersion || '?' }}</span>
            </div>

            @if (entry.installs.length > 1) {
              <div class="shadow-warning">
                <strong>{{ entry.installs.length - 1 }} other
                  {{ entry.installs.length - 1 === 1 ? 'copy' : 'copies' }}
                  found on PATH.</strong>
                @if (hasVersionMismatch(entry)) {
                  They report different versions — the one listed above wins,
                  the rest are stale or redundant.
                } @else {
                  All copies report the same version — low risk but still
                  redundant.
                }
              </div>
            }

            @if (expanded().has(entry.cli)) {
              <div class="details">
                <h4 class="details-title">All installs found</h4>
                <ul class="install-list">
                  @for (install of entry.installs; track install.path; let i = $index) {
                    <li>
                      <code class="path">{{ install.path }}</code>
                      <span class="version">v{{ install.version || '?' }}</span>
                      @if (i === 0) { <span class="tag">active</span> }
                      @else { <span class="tag tag-stale">shadow</span> }
                    </li>
                  }
                </ul>

                @if (entry.diagnosis && entry.diagnosis.recommendations.length > 0) {
                  <h4 class="details-title">Recommendations</h4>
                  <ul class="rec-list">
                    @for (rec of entry.diagnosis.recommendations; track rec) {
                      <li><pre class="rec-text">{{ rec }}</pre></li>
                    }
                  </ul>
                }

                @if (entry.updatePlan?.displayCommand) {
                  <h4 class="details-title">Updater</h4>
                  <pre class="rec-text">{{ entry.updatePlan?.displayCommand }}</pre>
                }

                @if (entry.diagnosis) {
                  <h4 class="details-title">Probes</h4>
                  <table class="probe-table">
                    <tbody>
                      @for (probe of entry.diagnosis.probes; track probe.name) {
                        <tr>
                          <td class="probe-name">{{ probe.name }}</td>
                          <td class="probe-status" [attr.data-status]="probe.status">
                            {{ probe.status }}
                          </td>
                          <td class="probe-msg">{{ probe.message }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                }
              </div>
            }
          }
        </div>
      }
    </div>
  `,
  styleUrl: './cli-health-settings-tab.component.scss',
})
export class CliHealthSettingsTabComponent implements OnInit {
  private readonly ipc = inject(ProviderIpcService);

  readonly entries = signal<CliDiagnosisEntry[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly expanded = signal<Set<string>>(new Set<string>());
  readonly updating = signal<Set<string>>(new Set<string>());
  readonly updateResults = signal<Record<string, CliUpdateResult>>({});
  readonly updateSummary = signal<string | null>(null);

  private readonly displayNames: Record<string, string> = {
    claude: 'Claude Code',
    codex: 'OpenAI Codex',
    gemini: 'Google Gemini',
    copilot: 'GitHub Copilot',
    cursor: 'Cursor Agent',
    ollama: 'Ollama',
  };

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const response = await this.ipc.diagnoseAllClis();
      if (!response.success) {
        this.error.set(response.error?.message || 'Failed to diagnose CLIs');
        return;
      }
      const data = response.data as { entries?: CliDiagnosisEntry[] } | undefined;
      this.entries.set(data?.entries ?? []);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }

  async updateCli(cli: string): Promise<void> {
    this.markUpdating(cli, true);
    this.error.set(null);
    this.updateSummary.set(null);
    try {
      const response = await this.ipc.updateCli(cli);
      if (!response.success) {
        this.error.set(response.error?.message || `Failed to update ${this.cliDisplayName(cli)}`);
        return;
      }

      const result = response.data as CliUpdateResult;
      this.updateResults.update((current) => ({ ...current, [cli]: result }));
      this.updateSummary.set(`${result.displayName}: ${this.updateStatusLabel(result.status).toLowerCase()}.`);
      await this.refresh();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.markUpdating(cli, false);
    }
  }

  async updateAll(): Promise<void> {
    const updatable = this.entries()
      .filter((entry) => entry.updatePlan?.supported)
      .map((entry) => entry.cli);
    if (updatable.length === 0) {
      this.updateSummary.set('No installed CLIs have an automatic updater configured.');
      return;
    }

    this.updating.set(new Set(updatable));
    this.error.set(null);
    this.updateSummary.set(null);
    try {
      const response = await this.ipc.updateAllClis();
      if (!response.success) {
        this.error.set(response.error?.message || 'Failed to update CLIs');
        return;
      }

      const data = response.data as { results?: CliUpdateResult[] } | undefined;
      const results = data?.results ?? [];
      const nextResults = { ...this.updateResults() };
      for (const result of results) {
        nextResults[result.cli] = result;
      }
      this.updateResults.set(nextResults);

      const completed = results.filter((result) => result.status === 'updated').length;
      const changed = results.filter((result) => this.versionChanged(result)).length;
      const failed = results.filter((result) => result.status === 'failed').length;
      const skipped = results.filter((result) => result.status === 'skipped').length;
      this.updateSummary.set(
        `CLI updater run complete: ${changed} version change${changed === 1 ? '' : 's'}, ` +
        `${completed - changed} completed with no detected version change, ${failed} failed, ${skipped} skipped.`,
      );
      await this.refresh();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.updating.set(new Set<string>());
    }
  }

  toggle(cli: string): void {
    const current = new Set(this.expanded());
    if (current.has(cli)) {
      current.delete(cli);
    } else {
      current.add(cli);
    }
    this.expanded.set(current);
  }

  cliDisplayName(cli: string): string {
    return this.displayNames[cli] ?? cli;
  }

  anyUpdating(): boolean {
    return this.updating().size > 0;
  }

  isUpdating(cli: string): boolean {
    return this.updating().has(cli);
  }

  updateResultFor(cli: string): CliUpdateResult | undefined {
    return this.updateResults()[cli];
  }

  updateStatusLabel(status: CliUpdateResult['status']): string {
    switch (status) {
      case 'updated': return 'Updater completed';
      case 'failed': return 'Failed';
      case 'skipped': return 'Skipped';
    }
  }

  severity(entry: CliDiagnosisEntry): Severity {
    if (entry.installs.length === 0) return 'missing';
    if (entry.diagnosis?.overall === 'unhealthy') return 'error';
    if (this.hasVersionMismatch(entry)) return 'warning';
    if (entry.installs.length > 1) return 'warning';
    if (entry.diagnosis?.overall === 'degraded') return 'warning';
    return 'healthy';
  }

  severityLabel(sev: Severity): string {
    switch (sev) {
      case 'healthy': return 'Healthy';
      case 'warning': return 'Warning';
      case 'error':   return 'Error';
      case 'missing': return 'Missing';
    }
  }

  hasVersionMismatch(entry: CliDiagnosisEntry): boolean {
    if (entry.installs.length < 2) return false;
    const versions = new Set(entry.installs.map((i) => i.version ?? 'unknown'));
    return versions.size > 1;
  }

  private versionChanged(result: CliUpdateResult): boolean {
    return result.status === 'updated' &&
      Boolean(result.beforeVersion) &&
      Boolean(result.afterVersion) &&
      result.beforeVersion !== result.afterVersion;
  }

  private markUpdating(cli: string, isUpdating: boolean): void {
    const current = new Set(this.updating());
    if (isUpdating) {
      current.add(cli);
    } else {
      current.delete(cli);
    }
    this.updating.set(current);
  }
}
