/**
 * Skill Health Panel — per-skill activation stats, correlation flags, and the
 * enable / suggest-only / disable control (kill-switch).
 *
 * Data comes from the skill-attribution IPC surface. Correlation numbers are
 * labelled as correlation, not causation.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { OrchestrationIpcService } from '../../core/services/ipc/orchestration-ipc.service';
import { SkillStore } from '../../core/state/skill.store';
import type {
  SkillControlMode,
  SkillControlRecord,
  SkillHealthEntry,
} from '../../../../shared/types/skill-observability.types';

interface HealthRow extends SkillHealthEntry {
  mode: SkillControlMode | null;
  errorShare: number;
  outlier: string | null;
}

const CONTROL_MODES: SkillControlMode[] = ['enabled', 'suggest-only', 'disabled'];

@Component({
  selector: 'app-skill-health-panel',
  standalone: true,
  template: `
    <div class="panel-card">
      <div class="panel-title">Skill Health</div>
      <div class="panel-note">
        Auto-injected skills recorded per session. Error flags are correlation, not causation.
      </div>

      @if (rows().length === 0) {
        <div class="hint">No skill activations recorded yet.</div>
      } @else {
        <div class="health-rows">
          @for (row of rows(); track row.skillName) {
            <div class="health-row" [class.disabled]="row.mode === 'disabled'">
              <div class="row-head">
                <span class="row-name">{{ row.skillName }}</span>
                @if (row.outlier) {
                  <span class="row-outlier" [title]="row.outlier">⚠ {{ row.outlier }}</span>
                }
              </div>
              <div class="row-stats">
                {{ row.totalActivations }} activation{{ row.totalActivations === 1 ? '' : 's' }}
                · ~{{ row.totalTokens }} tokens
                @if (row.precededErrors > 0) {
                  · preceded an error {{ row.precededErrors }}×
                }
                @if (row.lastUsedAt) {
                  · last {{ formatWhen(row.lastUsedAt) }}
                }
              </div>
              <div class="row-controls">
                @for (mode of controlModes; track mode) {
                  <button
                    type="button"
                    class="mode-btn"
                    [class.active]="(row.mode ?? 'enabled') === mode"
                    (click)="setMode(row.skillName, mode)"
                  >
                    {{ modeLabel(mode) }}
                  </button>
                }
              </div>
            </div>
          }
        </div>
      }

      <div class="button-row">
        <button class="btn" type="button" (click)="refresh()">Refresh</button>
      </div>
    </div>
  `,
  styles: [`
    .panel-card {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .panel-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
    }

    .panel-note {
      font-size: 11px;
      color: var(--text-muted);
    }

    .hint {
      font-size: 12px;
      color: var(--text-muted);
    }

    .health-rows {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      max-height: 320px;
      overflow: auto;
    }

    .health-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);

      &.disabled {
        opacity: 0.55;
      }
    }

    .row-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--spacing-sm);
    }

    .row-name {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .row-outlier {
      font-size: 10px;
      font-weight: 600;
      color: var(--warning-color, #d97706);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .row-stats {
      font-size: 11px;
      color: var(--text-muted);
    }

    .row-controls {
      display: flex;
      gap: 4px;
    }

    .mode-btn {
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: transparent;
      color: var(--text-muted);
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;

      &.active {
        background: var(--primary-color);
        border-color: var(--primary-color);
        color: #fff;
      }
    }

    .button-row {
      display: flex;
      gap: var(--spacing-sm);
    }

    .btn {
      padding: var(--spacing-xs) var(--spacing-md);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      cursor: pointer;
      font-size: 12px;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SkillHealthPanelComponent implements OnInit {
  private readonly orchestrationIpc = inject(OrchestrationIpcService);
  private readonly skillStore = inject(SkillStore);

  readonly controlModes = CONTROL_MODES;

  private readonly _summary = signal<readonly SkillHealthEntry[]>([]);

  readonly rows = computed<HealthRow[]>(() => {
    const controls = this.skillStore.controls();
    return this._summary().map((entry) => {
      const mode = controls.get(entry.skillName)?.mode ?? null;
      const errorShare = entry.totalActivations > 0
        ? entry.precededErrors / entry.totalActivations
        : 0;
      let outlier: string | null = null;
      if (entry.totalActivations >= 5 && errorShare >= 0.5) {
        outlier = `precedes an error ${entry.precededErrors}/${entry.totalActivations} times`;
      } else if (entry.totalActivations >= 50) {
        outlier = `fires very often (${entry.totalActivations} activations)`;
      }
      return { ...entry, mode, errorShare, outlier };
    });
  });

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const response = await this.orchestrationIpc.skillsHealthSummary();
    if (response.success && response.data && typeof response.data === 'object') {
      const data = response.data as {
        summary?: SkillHealthEntry[];
        controls?: SkillControlRecord[];
      };
      this._summary.set(data.summary ?? []);
    }
    await this.skillStore.refreshControls();
  }

  async setMode(skillName: string, mode: SkillControlMode): Promise<void> {
    await this.skillStore.setSkillControl(skillName, mode, 'set from skill health panel');
  }

  modeLabel(mode: SkillControlMode): string {
    switch (mode) {
      case 'enabled': return 'On';
      case 'suggest-only': return 'Suggest';
      case 'disabled': return 'Off';
    }
  }

  formatWhen(timestamp: number): string {
    const deltaMs = Date.now() - timestamp;
    if (deltaMs < 60_000) return 'just now';
    if (deltaMs < 3_600_000) return `${Math.round(deltaMs / 60_000)}m ago`;
    if (deltaMs < 86_400_000) return `${Math.round(deltaMs / 3_600_000)}h ago`;
    return `${Math.round(deltaMs / 86_400_000)}d ago`;
  }
}
