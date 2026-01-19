/**
 * Debate Timeline Component
 *
 * Track how positions evolve across rounds:
 * - Horizontal swim lanes per agent
 * - Position markers at each round
 * - Visual indicators for position changes
 */

import {
  Component,
  input,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';

export interface AgentPosition {
  agentId: string;
  positions: RoundPosition[];
}

export interface RoundPosition {
  roundNumber: number;
  roundType: 'initial' | 'critique' | 'defense' | 'synthesis';
  summary: string;
  confidence: number;
  changed: boolean;
}

@Component({
  selector: 'app-debate-timeline',
  standalone: true,
  template: `
    <div class="timeline-container">
      <div class="timeline-header">
        <h3 class="timeline-title">Argument Evolution</h3>
      </div>

      <div class="timeline-content">
        <!-- Round Headers -->
        <div class="round-headers">
          <div class="agent-column"></div>
          @for (label of roundLabels; track label) {
            <div class="round-label">{{ label }}</div>
          }
        </div>

        <!-- Agent Lanes -->
        @for (agent of agentPositions(); track agent.agentId) {
          <div class="agent-lane">
            <div class="agent-name">
              <span class="agent-icon">{{ getAgentIcon(agent.agentId) }}</span>
              {{ agent.agentId }}
            </div>
            <div class="positions-track">
              @for (pos of agent.positions; track pos.roundNumber; let i = $index) {
                <div class="position-wrapper">
                  @if (i > 0) {
                    <div
                      class="connector"
                      [class.changed]="pos.changed"
                    ></div>
                  }
                  <div
                    class="position-marker"
                    [class.changed]="pos.changed"
                    [style.--confidence]="pos.confidence"
                    (mouseenter)="hoveredPosition = pos"
                    (mouseleave)="hoveredPosition = null"
                  >
                    <div class="marker-dot"></div>
                    @if (pos.changed) {
                      <span class="change-indicator">△</span>
                    }
                  </div>

                  <!-- Tooltip -->
                  @if (hoveredPosition === pos) {
                    <div class="position-tooltip">
                      <div class="tooltip-header">
                        <span class="round-type">{{ formatRoundType(pos.roundType) }}</span>
                        <span class="confidence">{{ (pos.confidence * 100).toFixed(0) }}%</span>
                      </div>
                      <div class="tooltip-summary">{{ pos.summary }}</div>
                      @if (pos.changed) {
                        <div class="tooltip-change">Position revised</div>
                      }
                    </div>
                  }
                </div>
              }
            </div>
          </div>
        }

        @if (agentPositions().length === 0) {
          <div class="empty-state">
            <span class="empty-text">No position data available</span>
          </div>
        }
      </div>

      <!-- Legend -->
      <div class="timeline-legend">
        <span class="legend-item">
          <span class="legend-marker unchanged"></span>
          Position Maintained
        </span>
        <span class="legend-item">
          <span class="legend-marker changed"></span>
          Position Revised
        </span>
      </div>
    </div>
  `,
  styles: [`
    .timeline-container {
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
      height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .timeline-header {
      margin-bottom: var(--spacing-sm);
    }

    .timeline-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0;
    }

    .timeline-content {
      flex: 1;
      overflow-y: auto;
    }

    .round-headers {
      display: flex;
      margin-bottom: var(--spacing-sm);
      position: sticky;
      top: 0;
      background: var(--bg-tertiary);
      z-index: 1;
    }

    .agent-column {
      width: 80px;
      flex-shrink: 0;
    }

    .round-label {
      flex: 1;
      text-align: center;
      font-size: 9px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .agent-lane {
      display: flex;
      align-items: center;
      margin-bottom: var(--spacing-md);
      min-height: 50px;
    }

    .agent-name {
      width: 80px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      color: var(--text-primary);
    }

    .agent-icon {
      font-size: 14px;
    }

    .positions-track {
      flex: 1;
      display: flex;
      align-items: center;
      position: relative;
    }

    .position-wrapper {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
    }

    .connector {
      position: absolute;
      left: 0;
      width: calc(50% - 8px);
      height: 2px;
      background: var(--border-color);

      &.changed {
        background: linear-gradient(90deg, var(--border-color), #f59e0b);
      }
    }

    .position-marker {
      position: relative;
      width: 16px;
      height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 2;
    }

    .marker-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--primary-color);
      border: 2px solid var(--bg-tertiary);
      box-shadow: 0 0 0 2px var(--primary-color);
      transition: all var(--transition-fast);
    }

    .position-marker:hover .marker-dot {
      transform: scale(1.2);
    }

    .position-marker.changed .marker-dot {
      background: #f59e0b;
      box-shadow: 0 0 0 2px #f59e0b;
    }

    .change-indicator {
      position: absolute;
      top: -8px;
      font-size: 8px;
      color: #f59e0b;
    }

    .position-tooltip {
      position: absolute;
      top: calc(100% + 8px);
      left: 50%;
      transform: translateX(-50%);
      background: rgba(30, 30, 30, 0.95);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
      min-width: 150px;
      max-width: 250px;
      z-index: 100;
      font-size: 10px;
    }

    .tooltip-header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
    }

    .round-type {
      font-weight: 600;
      color: var(--text-primary);
    }

    .confidence {
      color: var(--primary-color);
    }

    .tooltip-summary {
      color: var(--text-secondary);
      line-height: 1.4;
    }

    .tooltip-change {
      margin-top: 4px;
      color: #f59e0b;
      font-weight: 500;
    }

    .timeline-legend {
      display: flex;
      justify-content: center;
      gap: var(--spacing-lg);
      padding-top: var(--spacing-sm);
      border-top: 1px solid var(--border-color);
      margin-top: var(--spacing-sm);
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 9px;
      color: var(--text-muted);
    }

    .legend-marker {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      border: 2px solid;

      &.unchanged {
        background: var(--primary-color);
        border-color: var(--primary-color);
      }

      &.changed {
        background: #f59e0b;
        border-color: #f59e0b;
      }
    }

    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--spacing-lg);
    }

    .empty-text {
      font-size: 11px;
      color: var(--text-muted);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DebateTimelineComponent {
  /** Input agent positions */
  agentPositions = input<AgentPosition[]>([]);

  /** Round labels */
  roundLabels = ['Initial', 'Critique', 'Defense', 'Synthesis'];

  /** Currently hovered position */
  hoveredPosition: RoundPosition | null = null;

  getAgentIcon(agentId: string): string {
    const icons = ['🤖', '🧠', '🔬', '📊', '💡', '🎯'];
    const hash = agentId.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
    return icons[hash % icons.length];
  }

  formatRoundType(type: string): string {
    return type.charAt(0).toUpperCase() + type.slice(1);
  }
}
