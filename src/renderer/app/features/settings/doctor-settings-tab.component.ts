import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CliHealthSettingsTabComponent } from './cli-health-settings-tab.component';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { DoctorStore } from '../../core/state/doctor.store';
import { SettingsStore } from '../../core/state/settings.store';
import type {
  BrowserAutomationHealthSnapshot,
  DoctorSectionId,
  OperatorArtifactExportResult,
} from '../../../../shared/types/diagnostics.types';

const DOCTOR_SECTION_IDS: readonly DoctorSectionId[] = [
  'startup-capabilities',
  'provider-health',
  'cli-health',
  'browser-automation',
  'commands-and-skills',
  'instructions',
  'operator-artifacts',
];

const RUNBOOK_BY_SECTION: Record<DoctorSectionId, string> = {
  'startup-capabilities': 'runbooks/doctor-updates-and-artifacts.md',
  'provider-health': 'runbooks/doctor-updates-and-artifacts.md',
  'cli-health': 'runbooks/doctor-updates-and-artifacts.md',
  'browser-automation': 'runbooks/doctor-updates-and-artifacts.md',
  'commands-and-skills': 'runbooks/command-help-and-palette.md',
  'instructions': 'runbooks/doctor-updates-and-artifacts.md',
  'operator-artifacts': 'runbooks/doctor-updates-and-artifacts.md',
};

function isDoctorSection(value: string | null): value is DoctorSectionId {
  return Boolean(value && (DOCTOR_SECTION_IDS as readonly string[]).includes(value));
}

@Component({
  selector: 'app-doctor-settings-tab',
  standalone: true,
  imports: [CliHealthSettingsTabComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="doctor-tab">
      <header class="doctor-header">
        <div>
          <h3 class="section-title">Doctor</h3>
          <p class="section-desc">Startup, provider, command, instruction, and artifact diagnostics.</p>
        </div>
        <button type="button" class="btn" (click)="refresh()" [disabled]="store.loading()">
          {{ store.loading() ? 'Refreshing...' : 'Refresh' }}
        </button>
      </header>

      @if (store.error()) {
        <div class="error-banner">{{ store.error() }}</div>
      }
      @if (docsError()) {
        <div class="error-banner">{{ docsError() }}</div>
      }

      @if (store.report(); as report) {
        <div class="doctor-layout">
          <nav class="section-nav" aria-label="Doctor sections">
            @for (section of report.sections; track section.id) {
              <button
                type="button"
                class="section-nav-item"
                [class.active]="store.activeSection() === section.id"
                [attr.data-severity]="section.severity"
                (click)="selectSection(section.id)"
              >
                <span class="section-nav-label">{{ section.label }}</span>
                <span class="section-nav-headline">{{ section.headline }}</span>
              </button>
            }
          </nav>

          <article class="section-pane">
            <div class="section-pane-actions">
              <button type="button" class="btn btn-secondary" (click)="openRunbook(store.activeSection())">
                Open Runbook
              </button>
            </div>
            @switch (store.activeSection()) {
              @case ('startup-capabilities') {
                <h4>Startup Capabilities</h4>
                @if (report.startupCapabilities) {
                  <p class="status-line" [attr.data-status]="report.startupCapabilities.status">
                    {{ report.startupCapabilities.status }} · {{ formatTime(report.startupCapabilities.generatedAt) }}
                  </p>
                  <div class="list">
                    @for (check of report.startupCapabilities.checks; track check.id) {
                      <div class="diagnostic-row" [attr.data-status]="check.status">
                        <strong>{{ check.label }}</strong>
                        <span>{{ check.status }}</span>
                        <p>{{ check.summary }}</p>
                      </div>
                    }
                  </div>
                } @else {
                  <p class="muted">Startup capability report is unavailable.</p>
                }
              }

              @case ('provider-health') {
                <h4>Provider Health</h4>
                <div class="list">
                  @for (diagnosis of report.providerDiagnoses; track diagnosis.provider) {
                    <div class="diagnostic-row" [attr.data-status]="diagnosis.overall">
                      <strong>{{ diagnosis.provider }}</strong>
                      <span>{{ providerStatusLabel(diagnosis.overall) }}</span>
                      @if (diagnosis.error) {
                        <p>{{ diagnosis.error }}</p>
                      } @else {
                        <p>{{ diagnosis.probes.length }} probe{{ diagnosis.probes.length === 1 ? '' : 's' }} checked.</p>
                      }
                      @if (diagnosis.recommendations.length > 0) {
                        <ul>
                          @for (recommendation of diagnosis.recommendations; track recommendation) {
                            <li>{{ recommendation }}</li>
                          }
                        </ul>
                      }
                      @if (diagnosis.repairActions.length > 0) {
                        <div class="repair-actions">
                          @for (action of diagnosis.repairActions; track action.kind) {
                            <div class="repair-action" [attr.data-severity]="action.severity">
                              <p class="repair-desc">{{ action.description }}</p>
                              @if (action.command) {
                                <div class="repair-command">
                                  <code>{{ action.command }}</code>
                                  <button
                                    type="button"
                                    class="copy-btn"
                                    (click)="copyCommand(action.command)"
                                  >
                                    {{ copiedCommand() === action.command ? 'Copied' : 'Copy' }}
                                  </button>
                                </div>
                              }
                            </div>
                          }
                        </div>
                      }
                    </div>
                  }
                </div>
              }

              @case ('cli-health') {
                <app-cli-health-settings-tab />
              }

              @case ('browser-automation') {
                <h4>Browser Automation</h4>
                @if (report.browserAutomation) {
                  <p class="status-line" [attr.data-status]="report.browserAutomation.status">
                    {{ browserAutomationStatusLabel(report.browserAutomation) }} · {{ formatTime(report.browserAutomation.checkedAt) }}
                  </p>
                  <dl class="facts">
                    <div><dt>Browser runtime</dt><dd>{{ report.browserAutomation.runtimeAvailable ? 'Ready' : 'Missing' }}</dd></div>
                    <div><dt>Node runtime</dt><dd>{{ report.browserAutomation.nodeAvailable ? 'Ready' : 'Missing' }}</dd></div>
                    <div><dt>Claude settings</dt><dd>{{ report.browserAutomation.configDetected ? 'Configured' : 'Not configured' }}</dd></div>
                    <div><dt>In-app server</dt><dd>{{ report.browserAutomation.inAppConnected ? 'Connected' : 'Not connected' }}</dd></div>
                    <div><dt>In-app tools</dt><dd>{{ report.browserAutomation.inAppToolCount }}</dd></div>
                  </dl>
                  @if (report.browserAutomation.warnings.length > 0) {
                    <ul class="issue-list">
                      @for (warning of report.browserAutomation.warnings; track warning) {
                        <li>{{ warning }}</li>
                      }
                    </ul>
                  }
                } @else {
                  <p class="muted">Browser automation diagnostics are unavailable.</p>
                }
              }

              @case ('commands-and-skills') {
                <h4>Commands & Skills</h4>
                @if (report.commandDiagnostics.available) {
                  @if (report.commandDiagnostics.diagnostics.length === 0) {
                    <p class="muted">No command diagnostics for this workspace.</p>
                  } @else {
                    <div class="list">
                      @for (diag of report.commandDiagnostics.diagnostics; track $index) {
                        <div class="diagnostic-row" [attr.data-status]="diag.severity">
                          <strong>{{ diag.code }}</strong>
                          <span>{{ diag.severity }}</span>
                          <p>{{ diag.message }}</p>
                        </div>
                      }
                    </div>
                  }
                } @else {
                  <p class="muted">{{ report.commandDiagnostics.reason }}</p>
                }

                @if (report.skillDiagnostics.length === 0) {
                  <p class="muted">No skill diagnostics.</p>
                } @else {
                  <div class="list">
                    @for (diag of report.skillDiagnostics; track $index) {
                      <div class="diagnostic-row" [attr.data-status]="diag.severity">
                        <strong>{{ diag.code }}</strong>
                        <span>{{ diag.severity }}</span>
                        <p>{{ diag.message }}</p>
                        @if (diag.filePath) { <code>{{ diag.filePath }}</code> }
                      </div>
                    }
                  </div>
                }
              }

              @case ('instructions') {
                <h4>Instructions</h4>
                @if (approvableTrustRows(report).length > 1) {
                  <button type="button" class="btn btn-secondary" (click)="approveAllTrust(report)" [disabled]="approvingTrust()">
                    {{ approvingTrust() ? 'Approving…' : 'Approve all listed files for this project' }}
                  </button>
                }
                @if (report.instructionDiagnostics.length === 0) {
                  <p class="muted">No instruction diagnostics for this workspace.</p>
                } @else {
                  <div class="list">
                    @for (diag of report.instructionDiagnostics; track $index) {
                      <div class="diagnostic-row" [attr.data-status]="diag.severity">
                        <strong>{{ diag.code }}</strong>
                        <span>{{ diag.severity }}</span>
                        <p>{{ diag.message }}</p>
                        @if (diag.filePath) { <code>{{ diag.filePath }}</code> }
                        @if (diag.code === 'instruction-trust' && diag.sha256 && diag.filePath && diag.scanSeverity !== 'critical') {
                          <button
                            type="button"
                            class="btn btn-secondary"
                            title="Pin this file at its current content hash; it re-flags if it changes again"
                            (click)="approveTrust(diag.filePath, diag.sha256)"
                            [disabled]="approvingTrust()"
                          >Approve</button>
                        }
                      </div>
                    }
                  </div>
                }
              }

              @case ('operator-artifacts') {
                <h4>Operator Artifacts</h4>
                <p class="muted">Exports are local, redacted, and never uploaded automatically.</p>
                <div class="artifact-actions">
                  <button type="button" class="btn" (click)="exportBundle()" [disabled]="exporting()">
                    {{ exporting() ? 'Exporting...' : 'Export Bundle' }}
                  </button>
                  @if (lastExport(); as result) {
                    <button type="button" class="btn btn-secondary" (click)="revealBundle(result.bundlePath)">
                      Show in Folder
                    </button>
                  }
                </div>
                @if (exportError()) {
                  <div class="error-banner">{{ exportError() }}</div>
                }
                @if (lastExport(); as result) {
                  <div class="export-result">
                    <code>{{ result.bundlePath }}</code>
                    <span>{{ result.bundleBytes }} bytes · {{ result.manifest.files.length }} files</span>
                  </div>
                }
              }
            }
          </article>
        </div>
      } @else if (store.loading()) {
        <p class="muted">Loading Doctor report...</p>
      }
    </section>
  `,
  styleUrl: './doctor-settings-tab.component.scss',
})
export class DoctorSettingsTabComponent implements OnInit {
  protected readonly store = inject(DoctorStore);
  private readonly settings = inject(SettingsStore);
  private readonly ipc = inject(ElectronIpcService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly exporting = signal(false);
  readonly exportError = signal<string | null>(null);
  readonly docsError = signal<string | null>(null);
  readonly lastExport = signal<OperatorArtifactExportResult | null>(null);
  /** The repair command most recently copied to the clipboard (for button feedback). */
  readonly copiedCommand = signal<string | null>(null);
  readonly workingDirectory = computed(() => {
    const configured = this.settings.get('defaultWorkingDirectory');
    return configured.trim() ? configured : undefined;
  });

  constructor() {
    this.route.queryParamMap
      .pipe(takeUntilDestroyed())
      .subscribe((params) => {
        const section = params.get('section');
        if (isDoctorSection(section)) {
          this.store.setActiveSection(section);
        }
      });
  }

  ngOnInit(): void {
    void this.refresh();
  }

  /**
   * Copies a Doctor repair-action command preview to the clipboard. The command
   * is only ever a preview the operator runs themselves — it is never executed
   * by the app. Briefly flips the button label to "Copied" for feedback.
   */
  async copyCommand(command: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      this.copiedCommand.set(command);
      setTimeout(() => {
        if (this.copiedCommand() === command) this.copiedCommand.set(null);
      }, 1500);
    } catch {
      // Clipboard may be unavailable (permissions); the command stays visible
      // for manual selection, so this is a non-fatal best-effort.
    }
  }

  refresh(): Promise<void> {
    return this.store.load({
      workingDirectory: this.workingDirectory(),
      force: true,
    });
  }

  selectSection(section: DoctorSectionId): void {
    this.store.setActiveSection(section);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: 'doctor', section },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** WS12: pending state for trust approvals. */
  readonly approvingTrust = signal(false);

  /** Trust rows that can be pinned (critical scanner findings are not one-click approvable). */
  approvableTrustRows(report: { instructionDiagnostics: { code: string; filePath?: string; sha256?: string; scanSeverity?: string }[] }): { path: string; sha256: string }[] {
    return report.instructionDiagnostics
      .filter((d) => d.code === 'instruction-trust' && d.filePath && d.sha256 && d.scanSeverity !== 'critical')
      .map((d) => ({ path: d.filePath as string, sha256: d.sha256 as string }));
  }

  async approveTrust(path: string, sha256: string): Promise<void> {
    await this.approveTrustFiles([{ path, sha256 }]);
  }

  async approveAllTrust(report: { instructionDiagnostics: { code: string; filePath?: string; sha256?: string; scanSeverity?: string }[] }): Promise<void> {
    await this.approveTrustFiles(this.approvableTrustRows(report));
  }

  private async approveTrustFiles(files: { path: string; sha256: string }[]): Promise<void> {
    if (files.length === 0) return;
    const api = this.ipc.getApi();
    if (!api?.instructionTrustApprove) return;
    this.approvingTrust.set(true);
    try {
      await api.instructionTrustApprove(files);
      // Re-collect so approved rows disappear from the list.
      await this.store.load({ workingDirectory: this.workingDirectory(), force: true });
    } finally {
      this.approvingTrust.set(false);
    }
  }

  async exportBundle(): Promise<void> {
    this.exporting.set(true);
    this.exportError.set(null);
    try {
      const result = await this.store.exportBundle({
        workingDirectory: this.workingDirectory(),
        force: true,
      });
      this.lastExport.set(result);
    } catch (error) {
      this.exportError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.exporting.set(false);
    }
  }

  async revealBundle(bundlePath: string): Promise<void> {
    try {
      await this.store.revealBundle(bundlePath);
    } catch (error) {
      this.exportError.set(error instanceof Error ? error.message : String(error));
    }
  }

  async openRunbook(section: DoctorSectionId): Promise<void> {
    this.docsError.set(null);
    const api = this.ipc.getApi();
    if (!api?.openDocsFile) {
      this.docsError.set('Documentation opener is unavailable.');
      return;
    }

    const response = await api.openDocsFile(RUNBOOK_BY_SECTION[section]);
    if (!response.success) {
      this.docsError.set(response.error?.message ?? 'Failed to open runbook.');
    }
  }

  formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  /**
   * Humanizes a provider's overall health for display. A `not-installed`
   * provider is a neutral, optional state (no subscription / not used) — it is
   * shown as "not installed" rather than an alarming raw status token.
   */
  providerStatusLabel(overall: string): string {
    return overall === 'not-installed' ? 'not installed' : overall;
  }

  browserAutomationStatusLabel(snapshot: BrowserAutomationHealthSnapshot): string {
    if (!snapshot.configDetected && !snapshot.inAppConfigured) {
      return 'Optional';
    }
    return snapshot.status;
  }
}
