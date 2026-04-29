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
                      <span>{{ diagnosis.overall }}</span>
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
                    {{ report.browserAutomation.status }} · {{ formatTime(report.browserAutomation.checkedAt) }}
                  </p>
                  <dl class="facts">
                    <div><dt>Browser runtime</dt><dd>{{ report.browserAutomation.runtimeAvailable ? 'Ready' : 'Missing' }}</dd></div>
                    <div><dt>Node runtime</dt><dd>{{ report.browserAutomation.nodeAvailable ? 'Ready' : 'Missing' }}</dd></div>
                    <div><dt>In-app server</dt><dd>{{ report.browserAutomation.inAppConnected ? 'Connected' : 'Not connected' }}</dd></div>
                    <div><dt>Tools</dt><dd>{{ report.browserAutomation.inAppToolCount }}</dd></div>
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
  styles: [`
    :host { display: block; }
    .doctor-tab { display: flex; flex-direction: column; gap: 1rem; }
    .doctor-header { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-start; }
    .section-title { margin: 0 0 0.25rem; font-size: 1.1rem; font-weight: 600; }
    .section-desc, .muted { margin: 0; color: var(--text-muted, #888); font-size: 0.875rem; }
    .btn {
      border: 1px solid var(--border-color, #2a2a2e);
      border-radius: 6px;
      background: var(--bg-secondary, #1a1a1a);
      color: var(--text-primary, #e5e5e5);
      cursor: pointer;
      font-size: 0.875rem;
      padding: 0.5rem 0.875rem;
      white-space: nowrap;
    }
    .btn:disabled { cursor: default; opacity: 0.6; }
    .btn-secondary { background: transparent; }
    .error-banner {
      padding: 0.625rem 0.875rem;
      border-radius: 6px;
      border: 1px solid rgba(255, 80, 80, 0.3);
      background: rgba(255, 80, 80, 0.1);
      color: #ff9a9a;
      font-size: 0.875rem;
    }
    .doctor-layout {
      display: grid;
      grid-template-columns: minmax(170px, 220px) minmax(0, 1fr);
      gap: 1rem;
      align-items: start;
    }
    .section-nav { display: flex; flex-direction: column; gap: 0.375rem; }
    .section-nav-item {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      width: 100%;
      min-height: 64px;
      border: 1px solid var(--border-color, #2a2a2e);
      border-radius: 8px;
      background: var(--bg-secondary, #1a1a1a);
      color: var(--text-secondary, #aaa);
      cursor: pointer;
      padding: 0.625rem;
      text-align: left;
    }
    .section-nav-item.active { border-color: var(--accent, #7aa2f7); color: var(--text-primary, #e5e5e5); }
    .section-nav-item[data-severity="warning"] { border-left: 3px solid #f0b43c; }
    .section-nav-item[data-severity="error"] { border-left: 3px solid #ff8080; }
    .section-nav-item[data-severity="info"] { border-left: 3px solid #7aa2f7; }
    .section-nav-label { font-size: 0.8125rem; font-weight: 700; }
    .section-nav-headline { font-size: 0.75rem; line-height: 1.3; color: var(--text-muted, #888); }
    .section-pane {
      min-width: 0;
      border: 1px solid var(--border-color, #2a2a2e);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.025);
      padding: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .section-pane-actions { display: flex; justify-content: flex-end; }
    .section-pane h4 { margin: 0; font-size: 1rem; }
    .status-line { margin: 0; font-size: 0.875rem; text-transform: capitalize; }
    .status-line[data-status="failed"],
    .status-line[data-status="unavailable"],
    [data-status="error"],
    [data-status="unhealthy"] { color: #ff9a9a; }
    .status-line[data-status="degraded"],
    [data-status="warning"],
    [data-status="warn"],
    [data-status="degraded"] { color: #f0d48a; }
    .list { display: flex; flex-direction: column; gap: 0.5rem; }
    .diagnostic-row {
      border: 1px solid var(--border-color, #2a2a2e);
      border-radius: 6px;
      padding: 0.625rem;
      background: var(--bg-secondary, #1a1a1a);
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 0.375rem 0.75rem;
      align-items: start;
    }
    .diagnostic-row p, .diagnostic-row ul { grid-column: 1 / -1; margin: 0; color: var(--text-secondary, #ccc); font-size: 0.8125rem; }
    .diagnostic-row code, .export-result code {
      grid-column: 1 / -1;
      max-width: 100%;
      overflow-wrap: anywhere;
      font-family: var(--font-family-mono, monospace);
      font-size: 0.75rem;
      color: var(--text-muted, #aaa);
    }
    .facts {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.5rem;
      margin: 0;
    }
    .facts div { border: 1px solid var(--border-color, #2a2a2e); border-radius: 6px; padding: 0.5rem; }
    .facts dt { color: var(--text-muted, #888); font-size: 0.75rem; }
    .facts dd { margin: 0.2rem 0 0; font-weight: 600; }
    .issue-list { margin: 0; padding-left: 1.1rem; color: var(--text-secondary, #ccc); }
    .artifact-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .export-result { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8125rem; color: var(--text-muted, #888); }
    @media (max-width: 860px) {
      .doctor-layout { grid-template-columns: 1fr; }
      .facts { grid-template-columns: 1fr; }
    }
  `],
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
}
