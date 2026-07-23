/**
 * Session Skills Badge — shows the skills recorded as injected into this
 * instance's session, with a popover detailing trigger/score/token cost and a
 * per-skill disable toggle (kill-switch write-through).
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { SkillStore } from '../../core/state/skill.store';

interface SessionSkillSummaryRow {
  skillName: string;
  count: number;
  totalTokens: number;
  matchedTrigger: string | null;
  matchScore: number | null;
  matchedBy: 'trigger' | 'embedding' | 'explicit';
  lastAt: number;
}

@Component({
  selector: 'app-session-skills-badge',
  standalone: true,
  template: `
    @if (sessionSkillCount() > 0) {
      <div class="session-skills">
        <button
          type="button"
          class="session-skills-badge"
          [class.open]="showPopover()"
          title="Skills injected into this session — click for details"
          (click)="onTogglePopover($event)"
        >
          ⚡ {{ sessionSkillCount() }} active
        </button>
        @if (showPopover()) {
          <div class="session-skills-popover">
            <div class="popover-title">Skills active this session</div>
            @for (row of sessionSkillSummary(); track row.skillName) {
              <div class="popover-row" [class.disabled]="isSkillDisabled(row.skillName)">
                <div class="row-main">
                  <span class="row-name">{{ row.skillName }}</span>
                  <span class="row-meta">
                    @if (row.matchedTrigger) {
                      matched "{{ row.matchedTrigger }}"
                    } @else if (row.matchedBy === 'embedding') {
                      semantic match{{ row.matchScore !== null ? ' ' + row.matchScore.toFixed(2) : '' }}
                    } @else {
                      loaded manually
                    }
                    · {{ row.count }}× · ~{{ row.totalTokens }} tokens
                  </span>
                </div>
                <button
                  type="button"
                  class="row-toggle"
                  [title]="isSkillDisabled(row.skillName)
                    ? 'Re-enable this skill'
                    : 'Disable this skill everywhere (takes effect next turn)'"
                  (click)="onToggleSkillDisabled(row.skillName)"
                >
                  {{ isSkillDisabled(row.skillName) ? 'Enable' : 'Disable' }}
                </button>
              </div>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .session-skills {
      position: relative;
      display: inline-flex;
    }

    .session-skills-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border-radius: 999px;
      font-family: var(--font-mono);
      font-size: 9px;
      font-weight: 600;
      cursor: pointer;
      color: inherit;
      border: 1px solid rgba(217, 119, 6, 0.35);
      background: rgba(217, 119, 6, 0.12);

      &:hover,
      &.open {
        background: rgba(217, 119, 6, 0.22);
      }
    }

    .session-skills-popover {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      z-index: 30;
      min-width: 280px;
      max-width: 380px;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: var(--bg-elevated, #1d2126);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);

      .popover-title {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        opacity: 0.7;
        margin-bottom: 8px;
      }

      .popover-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 6px 0;

        &.disabled .row-main {
          opacity: 0.45;
          text-decoration: line-through;
        }

        .row-main {
          display: flex;
          flex-direction: column;
          min-width: 0;
        }

        .row-name {
          font-size: 12px;
          font-weight: 600;
        }

        .row-meta {
          font-size: 10px;
          opacity: 0.65;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .row-toggle {
          flex-shrink: 0;
          padding: 3px 8px;
          border-radius: 6px;
          font-size: 10px;
          font-weight: 600;
          cursor: pointer;
          color: inherit;
          border: 1px solid rgba(255, 255, 255, 0.15);
          background: transparent;

          &:hover {
            background: rgba(255, 255, 255, 0.08);
          }
        }
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionSkillsBadgeComponent {
  private skillStore = inject(SkillStore);

  instanceId = input.required<string>();

  showPopover = signal(false);

  /**
   * Skills recorded as injected into THIS instance's session, aggregated per
   * skill (activation count, token cost, last matched trigger/score).
   */
  readonly sessionSkillSummary = computed<SessionSkillSummaryRow[]>(() => {
    const instanceId = this.instanceId();
    const rows = new Map<string, SessionSkillSummaryRow>();
    for (const activation of this.skillStore.activations()) {
      if (activation.instanceId !== instanceId) continue;
      const existing = rows.get(activation.skillName);
      if (existing) {
        existing.count += 1;
        existing.totalTokens += activation.tokensInjected;
        // Feed is newest-first, so the first record seen already holds the
        // latest trigger/score; only accumulate on subsequent ones.
      } else {
        rows.set(activation.skillName, {
          skillName: activation.skillName,
          count: 1,
          totalTokens: activation.tokensInjected,
          matchedTrigger: activation.matchedTrigger,
          matchScore: activation.matchScore,
          matchedBy: activation.matchedBy,
          lastAt: activation.createdAt,
        });
      }
    }
    return [...rows.values()].sort((a, b) => b.lastAt - a.lastAt);
  });

  readonly sessionSkillCount = computed(() => this.sessionSkillSummary().length);

  isSkillDisabled(skillName: string): boolean {
    return this.skillStore.controlModeFor(skillName) === 'disabled';
  }

  onTogglePopover(event: Event): void {
    event.stopPropagation();
    this.showPopover.update((open) => !open);
  }

  async onToggleSkillDisabled(skillName: string): Promise<void> {
    const nextMode = this.isSkillDisabled(skillName) ? 'enabled' : 'disabled';
    await this.skillStore.setSkillControl(skillName, nextMode, 'toggled from instance header');
  }
}
