import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { TaskPreflightReport } from '../../../../shared/types/task-preflight.types';

@Component({
  selector: 'app-task-preflight-card',
  standalone: true,
  imports: [CommonModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="preflight-card">
      <div class="card-header">
        <div>
          <h3>{{ title() }}</h3>
          <p>{{ subtitle() }}</p>
        </div>
        @if (loading()) {
          <span class="status-pill">Checking</span>
        } @else if (report()?.blockers?.length) {
          <span class="status-pill error">{{ report()!.blockers.length }} blocker{{ report()!.blockers.length === 1 ? '' : 's' }}</span>
        } @else if (report()) {
          <span class="status-pill ready">Ready</span>
        }
      </div>

      @if (loading()) {
        <p class="empty">{{ loadingMessage() }}</p>
      } @else if (!report()) {
        <p class="empty">{{ emptyMessage() }}</p>
      } @else {
        <div class="summary-grid">
          <div class="summary-item">
            <span class="summary-label">Instructions</span>
            <strong>{{ report()!.instructionSummary.appliedLabels.length }}</strong>
          </div>
          <div class="summary-item">
            <span class="summary-label">Filesystem</span>
            <strong>{{ report()!.filesystem.canWriteWorkingDirectory ? 'write-enabled' : 'restricted' }}</strong>
          </div>
          <div class="summary-item">
            <span class="summary-label">Network</span>
            <strong>{{ report()!.network.allowAllTraffic ? 'open' : report()!.network.allowedDomainCount + ' allowed' }}</strong>
          </div>
          <div class="summary-item">
            <span class="summary-label">MCP</span>
            <strong>{{ report()!.mcp.connectedCount }} connected</strong>
          </div>
          <div class="summary-item">
            <span class="summary-label">Browser</span>
            <strong>{{ report()!.mcp.browserStatus }}</strong>
          </div>
          <div class="summary-item">
            <span class="summary-label">Preset</span>
            <strong>{{ report()!.permissions.preset }}</strong>
          </div>
          <div class="summary-item">
            <span class="summary-label">Branch</span>
            <strong>{{ report()!.branchPolicy.action === 'allow' ? report()!.branchPolicy.state : report()!.branchPolicy.action }}</strong>
          </div>
        </div>

        @if (report()!.instructionSummary.appliedLabels.length > 0) {
          <p class="label-row">
            {{ report()!.instructionSummary.appliedLabels.join(' · ') }}
          </p>
        }

        @if (report()!.blockers.length > 0) {
          <div class="section">
            <span class="section-label error">Blockers</span>
            <ul class="list error">
              @for (blocker of report()!.blockers; track blocker) {
                <li>{{ blocker }}</li>
              }
            </ul>
          </div>
        }

        @if (report()!.warnings.length > 0) {
          <div class="section">
            <span class="section-label warn">Warnings</span>
            <ul class="list warn">
              @for (warning of report()!.warnings; track warning) {
                <li>{{ warning }}</li>
              }
            </ul>
          </div>
        }

        @if (report()!.branchPolicy.state !== 'not_repo') {
          <div class="section">
            <span class="section-label">Branch Policy</span>
            <ul class="list">
              <li>
                <strong>{{ report()!.branchPolicy.summary }}</strong>
                <span>
                  {{ report()!.branchPolicy.recommendedRemediation === 'none'
                    ? 'No remediation required.'
                    : 'Recommended remediation: ' + report()!.branchPolicy.recommendedRemediation + '.' }}
                </span>
              </li>
            </ul>
          </div>
        }

        @if (report()!.permissions.predictions.length > 0) {
          <div class="section">
            <span class="section-label">Predicted Prompts</span>
            <ul class="list">
              @for (prediction of report()!.permissions.predictions; track prediction.label + ':' + prediction.reason) {
                <li>
                  <strong>{{ prediction.label }}</strong>
                  <span>{{ prediction.certainty }}: {{ prediction.reason }}</span>
                </li>
              }
            </ul>
          </div>
        }

        @if (report()!.recommendedLinks.length > 0) {
          <div class="link-row">
            @for (link of uniqueLinks(); track link.route + ':' + link.label) {
              <a class="link-pill" [routerLink]="link.route">{{ link.label }}</a>
            }
          </div>
        }
      }
    </section>
  `,
  styles: [`
    :host {
      display: block;
    }

    .preflight-card {
      display: grid;
      gap: 0.9rem;
      padding: 1rem;
      border-radius: 0.95rem;
      border: 1px solid rgba(148, 163, 184, 0.16);
      background: rgba(8, 18, 30, 0.78);
    }

    .card-header,
    .summary-grid,
    .link-row {
      display: flex;
      gap: 0.75rem;
      justify-content: space-between;
    }

    .card-header {
      align-items: flex-start;
    }

    h3,
    p {
      margin: 0;
    }

    h3 {
      font-size: 1rem;
    }

    .card-header p,
    .empty,
    .label-row,
    .list span {
      color: #9fb3c7;
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    }

    .summary-item {
      display: grid;
      gap: 0.2rem;
      padding: 0.75rem 0.85rem;
      border-radius: 0.8rem;
      background: rgba(15, 23, 42, 0.72);
      border: 1px solid rgba(148, 163, 184, 0.12);
    }

    .summary-label,
    .section-label {
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 0.72rem;
      color: #82a2bf;
    }

    .section {
      display: grid;
      gap: 0.45rem;
    }

    .list {
      margin: 0;
      padding-left: 1.15rem;
      display: grid;
      gap: 0.35rem;
    }

    .list li {
      display: grid;
      gap: 0.12rem;
    }

    .status-pill,
    .link-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      padding: 0.36rem 0.72rem;
      font-size: 0.74rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .status-pill {
      background: rgba(148, 163, 184, 0.14);
      color: #e5eef6;
    }

    .status-pill.ready {
      background: rgba(34, 197, 94, 0.16);
      color: #bbf7d0;
    }

    .status-pill.error,
    .section-label.error,
    .list.error {
      color: #fecaca;
    }

    .section-label.warn,
    .list.warn {
      color: #fcd34d;
    }

    .link-row {
      justify-content: flex-start;
      flex-wrap: wrap;
    }

    .link-pill {
      text-decoration: none;
      background: rgba(56, 189, 248, 0.16);
      color: #bae6fd;
    }

    @media (max-width: 720px) {
      .card-header {
        flex-direction: column;
      }
    }
  `],
})
export class TaskPreflightCardComponent {
  readonly report = input<TaskPreflightReport | null>(null);
  readonly title = input('Task Preflight');
  readonly subtitle = input('Instructions, permissions, and tool readiness for this task.');
  readonly emptyMessage = input('Select a working directory to inspect task readiness.');
  readonly loading = input(false);
  readonly loadingMessage = input('Checking task readiness…');

  readonly uniqueLinks = computed(() => {
    const report = this.report();
    if (!report) {
      return [];
    }

    const seen = new Set<string>();
    return report.recommendedLinks.filter((link) => {
      const key = `${link.route}:${link.label}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  });
}
