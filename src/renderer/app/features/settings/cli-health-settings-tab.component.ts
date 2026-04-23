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
}

type Severity = 'healthy' | 'warning' | 'error' | 'missing';

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
        <button
          type="button"
          class="btn btn-secondary"
          (click)="refresh()"
          [disabled]="loading()"
        >
          {{ loading() ? 'Scanning...' : 'Refresh' }}
        </button>
      </div>

      @if (error()) {
        <div class="error-banner">{{ error() }}</div>
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
  styles: [`
    :host { display: block; }

    .cli-health-tab {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md, 1rem);
    }

    .tab-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 1rem;
    }

    .section-title {
      margin: 0 0 0.25rem 0;
      font-size: 1.1rem;
      font-weight: 600;
    }

    .section-desc {
      margin: 0;
      color: var(--text-muted, #888);
      font-size: 0.875rem;
      max-width: 52ch;
    }

    .btn {
      padding: 0.5rem 0.875rem;
      border-radius: 6px;
      border: 1px solid var(--border-color, #2a2a2e);
      background: var(--bg-secondary, #1a1a1a);
      color: var(--text-primary, #e5e5e5);
      font-size: 0.875rem;
      cursor: pointer;
    }
    .btn:disabled { opacity: 0.6; cursor: default; }
    .btn-secondary:hover:not(:disabled) { background: rgba(255,255,255,0.06); }

    .btn-link {
      background: none;
      border: none;
      color: var(--accent, #7aa2f7);
      cursor: pointer;
      font-size: 0.8125rem;
      padding: 0;
    }
    .btn-link:hover { text-decoration: underline; }

    .error-banner {
      padding: 0.625rem 0.875rem;
      border-radius: 6px;
      background: rgba(255, 80, 80, 0.1);
      border: 1px solid rgba(255, 80, 80, 0.3);
      color: #ff8080;
      font-size: 0.875rem;
    }

    .empty, .muted { color: var(--text-muted, #888); font-size: 0.875rem; }

    .cli-card {
      border: 1px solid var(--border-color, #2a2a2e);
      border-radius: 8px;
      padding: 0.875rem 1rem;
      background: var(--bg-secondary, #1a1a1a);
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .cli-card[data-severity="error"] { border-color: rgba(255, 80, 80, 0.5); }
    .cli-card[data-severity="warning"] { border-color: rgba(240, 180, 60, 0.5); }

    .cli-card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }

    .cli-name-block { display: flex; align-items: center; gap: 0.625rem; }
    .cli-name { font-weight: 600; font-size: 0.9375rem; }

    .cli-badge {
      font-size: 0.6875rem;
      padding: 0.125rem 0.5rem;
      border-radius: 999px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 600;
    }
    .cli-badge[data-severity="healthy"] { background: rgba(80, 200, 120, 0.15); color: #50c878; }
    .cli-badge[data-severity="warning"] { background: rgba(240, 180, 60, 0.15); color: #f0b43c; }
    .cli-badge[data-severity="error"]   { background: rgba(255, 80, 80, 0.15); color: #ff8080; }
    .cli-badge[data-severity="missing"] { background: rgba(150, 150, 150, 0.15); color: #aaa; }

    .active-row {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      font-size: 0.8125rem;
      flex-wrap: wrap;
    }
    .label { color: var(--text-muted, #888); }
    .path {
      font-family: var(--font-family-mono, monospace);
      background: rgba(255,255,255,0.04);
      padding: 0.125rem 0.375rem;
      border-radius: 4px;
      font-size: 0.8125rem;
    }
    .version { color: var(--text-muted, #aaa); font-size: 0.8125rem; }

    .shadow-warning {
      font-size: 0.8125rem;
      padding: 0.5rem 0.625rem;
      border-radius: 4px;
      background: rgba(240, 180, 60, 0.08);
      border-left: 3px solid #f0b43c;
      color: var(--text-secondary, #ccc);
    }

    .details {
      margin-top: 0.25rem;
      border-top: 1px solid var(--border-color, #2a2a2e);
      padding-top: 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .details-title {
      margin: 0.375rem 0 0.25rem;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted, #888);
    }

    .install-list, .rec-list {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .install-list li {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      flex-wrap: wrap;
      font-size: 0.8125rem;
    }

    .tag {
      font-size: 0.6875rem;
      padding: 0.0625rem 0.375rem;
      border-radius: 999px;
      background: rgba(80, 200, 120, 0.15);
      color: #50c878;
    }
    .tag-stale { background: rgba(240, 180, 60, 0.15); color: #f0b43c; }

    .rec-text {
      margin: 0;
      font-family: var(--font-family-mono, monospace);
      font-size: 0.8125rem;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--text-secondary, #ccc);
    }

    .probe-table {
      width: 100%;
      font-size: 0.8125rem;
      border-collapse: collapse;
    }
    .probe-table td { padding: 0.25rem 0.5rem; vertical-align: top; }
    .probe-table tr:nth-child(even) { background: rgba(255,255,255,0.02); }
    .probe-name { font-family: var(--font-family-mono, monospace); color: var(--text-muted, #aaa); }
    .probe-status { text-transform: uppercase; font-weight: 600; font-size: 0.6875rem; }
    .probe-status[data-status="pass"] { color: #50c878; }
    .probe-status[data-status="fail"] { color: #ff8080; }
    .probe-status[data-status="skip"] { color: #888; }
    .probe-status[data-status="timeout"] { color: #f0b43c; }
    .probe-msg { color: var(--text-secondary, #ccc); white-space: pre-wrap; }
  `],
})
export class CliHealthSettingsTabComponent implements OnInit {
  private readonly ipc = inject(ProviderIpcService);

  readonly entries = signal<CliDiagnosisEntry[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly expanded = signal<Set<string>>(new Set<string>());

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
}
