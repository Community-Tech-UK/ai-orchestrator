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
  computed,
  inject,
  signal,
} from '@angular/core';
import { ProviderIpcService } from '../../core/services/ipc/provider-ipc.service';
import { CliUpdatePillStore } from '../../core/state/cli-update-pill.store';
import { SettingsStore } from '../../core/state/settings.store';
import { SegmentedControlComponent, type SegmentOption } from './ui/segmented-control.component';
import type { CliUpdatePolicy } from '../../../../shared/types/settings.types';

interface CliInstall {
  path: string;
  version?: string;
  installed: boolean;
  error?: string;
  /**
   * Set by the main-process scan when the CLI's own installer maintains this
   * copy as a duplicate of an install already in the list — e.g. the
   * `~/.grok/bin` binary grok's npm postinstall writes beside its shim. Shown,
   * but never counted as a separate or conflicting install.
   */
  installerCopy?: true;
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
  /** Latest published version, when known (registry-backed). */
  latestVersion?: string;
  /** True when the active install is behind the latest published version. */
  updateAvailable?: boolean;
  diagnosis: {
    provider: string;
    probes: ProbeResult[];
    overall: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
    recommendations: string[];
  } | null;
  updatePlan?: CliUpdatePlan;
}

type Severity = 'healthy' | 'warning' | 'error' | 'missing';

/**
 * How the separately installed copies of a CLI relate: they all report one
 * version, only some versions could be read, none could, or they disagree.
 */
type VersionAgreement = 'agree' | 'partial' | 'unreadable' | 'conflict';

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
  imports: [SegmentedControlComponent],
  template: `
    <div class="cli-health-tab">
      <div class="tab-header">
        <div>
          <h3 class="section-title">AI CLI health</h3>
          <p class="section-desc">
            Shows each AI CLI (command-line tool) that is installed on this
            machine: which copy is active, what version it reports, and whether
            multiple conflicting copies are present on your system PATH.
          </p>
        </div>
        <div class="header-actions">
          <button
            type="button"
            class="btn btn-secondary"
            (click)="updateAll()"
            [disabled]="loading() || anyUpdating()"
          >
            {{ anyUpdating() ? 'Updating...' : 'Update all' }}
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

      <div class="update-policy">
        <div class="update-policy-text">
          <span class="field-label">Automatic updates</span>
          <span class="field-hint">
            How Harness handles newer published versions of these CLIs.
            <strong>Off</strong> stops checking entirely.
            <strong>Notify</strong> (default) shows an “Update available” badge so you
            can update with one click. <strong>Auto</strong> installs safe updates in the
            background — only while no agents are running.
          </span>
        </div>
        <app-segmented-control
          ariaLabel="Automatic CLI update policy"
          [options]="policyOptions"
          [value]="updatePolicy()"
          (valueChange)="onPolicyChange($event)"
        />
      </div>

      @if (error()) {
        <div class="error-banner">{{ error() }}</div>
      }

      @if (updateSummary()) {
        <div class="update-summary">{{ updateSummary() }}</div>
      }

      @if (entries().length === 0 && !loading()) {
        <p class="empty">No AI CLIs detected. Install Claude Code, Gemini, or another supported CLI and click Refresh.</p>
      }

      @for (entry of entries(); track entry.cli) {
        <div class="cli-card" [attr.data-severity]="severity(entry)">
          <div class="cli-card-head">
            <div class="cli-name-block">
              <span class="cli-name">{{ cliDisplayName(entry.cli) }}</span>
              <span class="cli-badge" [attr.data-severity]="severity(entry)">
                {{ severityLabel(severity(entry)) }}
              </span>
              @if (entry.updateAvailable) {
                <span class="update-badge" [title]="updateBadgeTooltip(entry)">
                  Update available
                </span>
              }
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
              <span class="label">In use:</span>
              <code class="path">{{ entry.activePath }}</code>
              <span class="version">v{{ entry.activeVersion || '?' }}</span>
              @if (entry.updateAvailable && entry.latestVersion) {
                <span class="version-latest">→ v{{ entry.latestVersion }} available</span>
              }
            </div>

            @if (hasVersionMismatch(entry)) {
              <div class="shadow-warning">
                <strong>{{ otherCopyCount(entry) }} other
                  {{ otherCopyCount(entry) === 1 ? 'copy' : 'copies' }}
                  found on PATH.</strong>
                Not all of them report the same version, and the one listed
                above wins. Check this CLI's recommendation under Show details
                before removing anything — some CLIs keep a second copy on
                purpose.
              </div>
            } @else {
              @if (copiesNote(entry); as note) {
                <p class="duplicate-note">{{ note }}</p>
              }
            }

            @if (expanded().has(entry.cli)) {
              <div class="details">
                <h4 class="details-title">All copies found on PATH</h4>
                <ul class="install-list">
                  @for (install of entry.installs; track install.path; let i = $index) {
                    <li>
                      <code class="path">{{ install.path }}</code>
                      <span class="version">v{{ install.version || '?' }}</span>
                      @if (install.installerCopy) {
                        <span class="tag tag-duplicate">installer copy</span>
                        <span class="sr-only">
                          Kept by this CLI's own installer as a duplicate of an
                          install listed above, at the same version.
                        </span>
                      } @else if (i === 0) {
                        <span class="tag">active</span>
                      } @else if (shadowsActiveVersion(entry, install)) {
                        <span class="tag tag-stale">shadow</span>
                      } @else if (!comparableToActive(entry, install)) {
                        <span class="tag tag-duplicate">version unknown</span>
                      } @else {
                        <span class="tag tag-duplicate">duplicate</span>
                      }
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
                  <h4 class="details-title">Update command</h4>
                  <pre class="rec-text">{{ entry.updatePlan?.displayCommand }}</pre>
                }

                @if (entry.diagnosis) {
                  <h4 class="details-title">Health checks</h4>
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
  private readonly cliUpdates = inject(CliUpdatePillStore);
  private readonly settings = inject(SettingsStore);

  /** Current `cliUpdatePolicy` setting, driving the segmented control. */
  readonly updatePolicy = computed<CliUpdatePolicy>(
    () => this.settings.settings().cliUpdatePolicy ?? 'notify',
  );

  readonly policyOptions: SegmentOption[] = [
    { value: 'off', label: 'Off' },
    { value: 'notify', label: 'Notify' },
    { value: 'auto', label: 'Auto' },
  ];

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
    gemini: 'Google Gemini (legacy)',
    antigravity: 'Antigravity',
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
      // Re-sync the title-bar "Update CLIs" pill with what this page just
      // computed. The poll service backing the pill otherwise only refreshes on
      // launch and every 6h, so without this nudge the badge keeps showing a
      // stale update count after the user updates a CLI here (or once everything
      // is already current) — the "badge doesn't update even when everything is
      // healthy" bug. Fire-and-forget: the pill updates asynchronously and
      // must not gate this page's own loading state.
      void this.cliUpdates.refresh();
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
      this.updateSummary.set('None of the detected CLIs support automatic updates from here.');
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
        `Update run finished: ${changed} version${changed === 1 ? '' : 's'} changed, ` +
        `${completed - changed} already up to date, ${failed} failed, ${skipped} skipped.`,
      );
      await this.refresh();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.updating.set(new Set<string>());
    }
  }

  /**
   * Persist a new auto-update policy. The main-process settings manager emits
   * `setting:cliUpdatePolicy`, which `CliAutoUpdateService` is subscribed to, so
   * flipping to "Auto" takes effect immediately (it re-evaluates pending
   * updates) without a restart.
   */
  onPolicyChange(value: string): void {
    void this.settings.set('cliUpdatePolicy', value as CliUpdatePolicy);
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

  /**
   * Renderer-side overrides first (they carry UI-only wording such as the
   * "legacy" marker), then the name the main process sent with the update plan
   * — which comes from CLI_REGISTRY, so a newly registered CLI reads as
   * "Grok Build" rather than the raw `grok` id without a second edit here.
   */
  cliDisplayName(cli: string): string {
    const override = this.displayNames[cli];
    if (override) return override;
    const planName = this.entries().find((entry) => entry.cli === cli)?.updatePlan?.displayName;
    return planName || cli;
  }

  updateBadgeTooltip(entry: CliDiagnosisEntry): string {
    const action = entry.updatePlan?.supported
      ? 'Click "Run updater" to upgrade.'
      : 'Update it from where it was installed.';
    if (entry.activeVersion && entry.latestVersion) {
      return `${entry.activeVersion} → ${entry.latestVersion}. ${action}`;
    }
    return `A newer version is available. ${action}`;
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
      case 'updated': return 'Updated';
      case 'failed': return 'Update failed';
      case 'skipped': return 'Skipped';
    }
  }

  /**
   * Card badge. Extra copies at the *same* version are deliberately not a
   * warning: nothing can silently win on PATH and the probe suite passes, so
   * badging it "Warning" was noise — and for an installer-maintained copy
   * (`installerCopy`, which `separateInstalls` discards) noise the user could never
   * clear. Only a version disagreement between separate copies, or a probe
   * failure, warrants one.
   */
  severity(entry: CliDiagnosisEntry): Severity {
    if (entry.installs.length === 0) return 'missing';
    if (entry.diagnosis?.overall === 'unhealthy') return 'error';
    if (this.hasVersionMismatch(entry)) return 'warning';
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

  /**
   * Copies that are genuinely separate installs. A copy the CLI's own
   * installer maintains (`installerCopy`) duplicates an install already in
   * the list — grok's npm postinstall writes one into `~/.grok/bin` on every
   * install — so counting it would flag a conflict that does not exist and
   * cannot be cleared.
   */
  separateInstalls(entry: CliDiagnosisEntry): CliInstall[] {
    return entry.installs.filter((install) => !install.installerCopy);
  }

  mirrorCount(entry: CliDiagnosisEntry): number {
    return entry.installs.length - this.separateInstalls(entry).length;
  }

  /**
   * How far the separate copies agree. A version that could not be read is
   * unknown, not different: treating it as a distinct version made a
   * transient probe failure flash "they report different versions" until the
   * next scan cleared it, and claiming the copies "all report the same
   * version" when nothing was read is just as wrong. Mirrors the
   * main-process `knownInstallVersions` rule.
   */
  versionAgreement(entry: CliDiagnosisEntry): VersionAgreement {
    const separate = this.separateInstalls(entry);
    const known = new Set(
      separate.flatMap((install) => (install.version ? [install.version] : [])),
    );
    if (known.size > 1) return 'conflict';
    if (known.size === 0) return 'unreadable';
    return separate.every((install) => install.version) ? 'agree' : 'partial';
  }

  hasVersionMismatch(entry: CliDiagnosisEntry): boolean {
    return this.separateInstalls(entry).length > 1
      && this.versionAgreement(entry) === 'conflict';
  }

  /**
   * Every copy on PATH besides the active one — installer-maintained ones
   * included, so the banner accounts for exactly the rows the details list
   * shows rather than under-counting them.
   */
  otherCopyCount(entry: CliDiagnosisEntry): number {
    return Math.max(entry.installs.length - 1, 0);
  }

  /**
   * True when this copy reports a different version from the active one — the
   * only rows that can actually shadow it. A copy at the same version is
   * redundant, not stale, even when some *other* copy disagrees.
   */
  shadowsActiveVersion(entry: CliDiagnosisEntry, install: CliInstall): boolean {
    return this.comparableToActive(entry, install)
      && install.version !== this.separateInstalls(entry)[0]?.version;
  }

  /**
   * Whether this copy and the active one both reported a version. When either
   * did not, the row is neither a "duplicate" nor a "shadow" — calling it the
   * same would break the rule the rest of the card keeps: unknown is not the
   * same, and unknown is not different.
   */
  comparableToActive(entry: CliDiagnosisEntry, install: CliInstall): boolean {
    return Boolean(this.separateInstalls(entry)[0]?.version && install.version);
  }

  /**
   * The line under "In use:" accounting for every other row the details list
   * shows, or null when there is nothing to account for. Kept in TypeScript
   * rather than nested template branches so the wording is directly testable
   * — it is the sentence that has to stay true for the card not to contradict
   * the `cli_shadow_check` row beside it.
   */
  copiesNote(entry: CliDiagnosisEntry): string | null {
    const separate = this.separateInstalls(entry);
    const mirrors = this.mirrorCount(entry);
    const copies = (count: number): string => `${count} ${count === 1 ? 'copy' : 'copies'}`;

    if (separate.length < 2) {
      return mirrors === 0
        ? null
        : `Installed once. Its installer keeps ${mirrors === 1 ? 'another copy' : copies(mirrors)}`
          + ' on PATH at the same version — expected, nothing to do.';
    }

    const extra = mirrors === 0
      ? ''
      : ` Its installer keeps ${mirrors === 1 ? 'one more copy' : `${mirrors} more copies`}`
        + ' beside them.';
    const version = separate.find((install) => install.version)?.version;
    switch (this.versionAgreement(entry)) {
      case 'agree':
        return `${copies(separate.length)} on PATH, all reporting v${version}.`
          + ` Nothing to do — the first one is used.${extra}`;
      case 'partial':
        return `${copies(separate.length)} on PATH. Every version that could be read is`
          + ` v${version}; the rest did not report one. Nothing looks wrong — the first`
          + ` copy is used.${extra}`;
      case 'unreadable':
        return `${copies(separate.length)} on PATH, none of which reported a version.`
          + ` Nothing looks wrong — the first copy is used.${extra}`;
      case 'conflict':
        // Rendered as the warning banner instead.
        return null;
    }
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
