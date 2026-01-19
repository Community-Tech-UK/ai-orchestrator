/**
 * Debate Visualization Component
 *
 * Display multi-round debate process and consensus building:
 * - Round-by-round progression visualization
 * - Agent contributions and critiques
 * - Consensus score tracking
 * - Final synthesis display
 * - Key agreements and disagreements
 */

import {
  Component,
  input,
  output,
  signal,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { SlicePipe } from '@angular/common';
import type {
  DebateResult,
  ActiveDebate,
  DebateSessionRound,
  DebateContribution,
  AgentCritique,
  DebateStatus,
  DebateRoundType,
  ConsensusAnalysis,
  DebateStats,
} from '../../../../shared/types/debate.types';

@Component({
  selector: 'app-debate-visualization',
  standalone: true,
  imports: [SlicePipe],
  template: `
    <div class="debate-container">
      <!-- Header -->
      <div class="debate-header">
        <div class="header-left">
          <span class="debate-icon">🗣️</span>
          <span class="debate-title">Debate Consensus</span>
          @if (activeDebate(); as debate) {
            <span class="status-badge" [class]="'status-' + debate.status">
              {{ formatStatus(debate.status) }}
            </span>
          }
        </div>
        <div class="header-actions">
          @if (activeDebate()?.status === 'in_progress') {
            <button class="action-btn danger" (click)="cancelDebate.emit()">
              Cancel
            </button>
          } @else if (!activeDebate()) {
            <button class="action-btn primary" (click)="startDebate.emit()">
              Start Debate
            </button>
          }
        </div>
      </div>

      @if (activeDebate() || debateResult(); as debate) {
        <!-- Query Display -->
        <div class="query-section">
          <span class="query-label">Query</span>
          <div class="query-content">{{ getQuery() }}</div>
        </div>

        <!-- Progress & Consensus -->
        <div class="progress-section">
          <div class="round-progress">
            <span class="progress-label">Round Progress</span>
            <div class="rounds-indicator">
              @for (round of [1, 2, 3, 4]; track round) {
                <div
                  class="round-dot"
                  [class.completed]="getCurrentRound() > round"
                  [class.current]="getCurrentRound() === round"
                  [class.pending]="getCurrentRound() < round"
                >
                  {{ round }}
                </div>
                @if (round < 4) {
                  <div
                    class="round-connector"
                    [class.completed]="getCurrentRound() > round"
                  ></div>
                }
              }
            </div>
            <div class="round-labels">
              <span>Initial</span>
              <span>Critique</span>
              <span>Defense</span>
              <span>Synthesis</span>
            </div>
          </div>

          <div class="consensus-display">
            <span class="consensus-label">Consensus Score</span>
            <div class="consensus-gauge">
              <div
                class="consensus-fill"
                [style.width.%]="getConsensusScore() * 100"
                [class.high]="getConsensusScore() >= 0.8"
                [class.medium]="getConsensusScore() >= 0.5 && getConsensusScore() < 0.8"
                [class.low]="getConsensusScore() < 0.5"
              ></div>
            </div>
            <span class="consensus-value">{{ (getConsensusScore() * 100).toFixed(0) }}%</span>
          </div>
        </div>

        <!-- Rounds Display -->
        <div class="rounds-section">
          <div class="rounds-header">
            <span class="rounds-title">Debate Rounds</span>
            <div class="round-tabs">
              @for (round of getRounds(); track round.roundNumber) {
                <button
                  class="round-tab"
                  [class.active]="selectedRound() === round.roundNumber"
                  (click)="selectRound(round.roundNumber)"
                >
                  {{ getRoundLabel(round.type) }}
                </button>
              }
            </div>
          </div>

          @if (getSelectedRoundData(); as round) {
            <div class="round-content">
              <div class="round-meta">
                <span class="meta-item">
                  Round {{ round.roundNumber }} - {{ getRoundLabel(round.type) }}
                </span>
                <span class="meta-item">
                  Consensus: {{ (round.consensusScore * 100).toFixed(0) }}%
                </span>
                <span class="meta-item">
                  Duration: {{ formatDuration(round.durationMs) }}
                </span>
              </div>

              <div class="contributions-grid">
                @for (contribution of round.contributions; track contribution.agentId) {
                  <div class="contribution-card">
                    <div class="contribution-header">
                      <span class="agent-badge">
                        {{ getAgentIcon(contribution.agentId) }} {{ contribution.agentId }}
                      </span>
                      <span class="confidence-badge">
                        {{ (contribution.confidence * 100).toFixed(0) }}% confident
                      </span>
                    </div>

                    <div class="contribution-content">
                      {{ truncate(contribution.content, 300) }}
                    </div>

                    @if (contribution.reasoning) {
                      <div class="contribution-reasoning">
                        <span class="reasoning-label">Reasoning:</span>
                        {{ truncate(contribution.reasoning, 150) }}
                      </div>
                    }

                    @if (contribution.critiques && contribution.critiques.length > 0) {
                      <div class="critiques-section">
                        <span class="critiques-label">Critiques:</span>
                        @for (critique of contribution.critiques; track critique.targetAgentId) {
                          <div class="critique-item" [class]="'severity-' + critique.severity">
                            <span class="critique-target">→ {{ critique.targetAgentId }}</span>
                            <span class="critique-severity">{{ critique.severity }}</span>
                            <span class="critique-issue">{{ critique.issue }}</span>
                            @if (critique.counterpoint) {
                              <span class="critique-counter">Counter: {{ critique.counterpoint }}</span>
                            }
                          </div>
                        }
                      </div>
                    }

                    @if (contribution.defenses && contribution.defenses.length > 0) {
                      <div class="defenses-section">
                        <span class="defenses-label">Defenses:</span>
                        @for (defense of contribution.defenses; track defense) {
                          <div class="defense-item">{{ defense }}</div>
                        }
                      </div>
                    }
                  </div>
                }
              </div>
            </div>
          }
        </div>

        <!-- Result Section (for completed debates) -->
        @if (debateResult(); as result) {
          <div class="result-section">
            <div class="result-header">
              <span class="result-title">Synthesis Result</span>
              @if (result.consensusReached) {
                <span class="consensus-badge reached">✓ Consensus Reached</span>
              } @else {
                <span class="consensus-badge not-reached">✗ No Consensus</span>
              }
            </div>

            <div class="synthesis-content">
              {{ result.synthesis }}
            </div>

            <div class="agreements-disagreements">
              @if (result.keyAgreements.length > 0) {
                <div class="agreements-section">
                  <span class="section-label">Key Agreements</span>
                  <ul class="agreements-list">
                    @for (agreement of result.keyAgreements; track agreement) {
                      <li class="agreement-item">✓ {{ agreement }}</li>
                    }
                  </ul>
                </div>
              }

              @if (result.unresolvedDisagreements.length > 0) {
                <div class="disagreements-section">
                  <span class="section-label">Unresolved Disagreements</span>
                  <ul class="disagreements-list">
                    @for (disagreement of result.unresolvedDisagreements; track disagreement) {
                      <li class="disagreement-item">⚠ {{ disagreement }}</li>
                    }
                  </ul>
                </div>
              }
            </div>

            <div class="result-stats">
              <div class="stat-item">
                <span class="stat-label">Total Rounds</span>
                <span class="stat-value">{{ result.rounds.length }}</span>
              </div>
              <div class="stat-item">
                <span class="stat-label">Final Consensus</span>
                <span class="stat-value">{{ (result.finalConsensusScore * 100).toFixed(0) }}%</span>
              </div>
              <div class="stat-item">
                <span class="stat-label">Tokens Used</span>
                <span class="stat-value">{{ formatNumber(result.tokensUsed) }}</span>
              </div>
              <div class="stat-item">
                <span class="stat-label">Duration</span>
                <span class="stat-value">{{ formatDuration(result.duration) }}</span>
              </div>
            </div>
          </div>
        }
      } @else {
        <!-- No Debate State -->
        <div class="no-debate">
          <span class="no-debate-icon">🗣️</span>
          <span class="no-debate-title">No Active Debate</span>
          <span class="no-debate-text">
            Start a debate to use multi-round consensus building for complex decisions.
          </span>
          <div class="debate-info">
            <div class="info-item">
              <span class="info-icon">1️⃣</span>
              <span class="info-text">Initial: Independent responses from multiple agents</span>
            </div>
            <div class="info-item">
              <span class="info-icon">2️⃣</span>
              <span class="info-text">Critique: Each agent critiques others' responses</span>
            </div>
            <div class="info-item">
              <span class="info-icon">3️⃣</span>
              <span class="info-text">Defense: Agents defend or revise their positions</span>
            </div>
            <div class="info-item">
              <span class="info-icon">4️⃣</span>
              <span class="info-text">Synthesis: Moderator extracts best elements</span>
            </div>
          </div>
        </div>
      }

      <!-- Stats Section -->
      @if (stats(); as statsData) {
        <div class="stats-section">
          <span class="stats-title">Debate Statistics</span>
          <div class="stats-grid">
            <div class="stat-card">
              <span class="stat-value">{{ statsData.totalDebates }}</span>
              <span class="stat-label">Total Debates</span>
            </div>
            <div class="stat-card">
              <span class="stat-value">{{ statsData.avgRounds.toFixed(1) }}</span>
              <span class="stat-label">Avg Rounds</span>
            </div>
            <div class="stat-card">
              <span class="stat-value">{{ (statsData.avgConsensusScore * 100).toFixed(0) }}%</span>
              <span class="stat-label">Avg Consensus</span>
            </div>
            <div class="stat-card">
              <span class="stat-value">{{ (statsData.consensusRate * 100).toFixed(0) }}%</span>
              <span class="stat-label">Consensus Rate</span>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .debate-container {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      display: flex;
      flex-direction: column;
      max-height: 800px;
      overflow: hidden;
    }

    .debate-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .debate-icon {
      font-size: 20px;
    }

    .debate-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .status-badge {
      padding: 3px 8px;
      border-radius: var(--radius-sm);
      font-size: 10px;
      font-weight: 600;

      &.status-pending { background: rgba(107, 114, 128, 0.2); color: #6b7280; }
      &.status-in_progress { background: rgba(59, 130, 246, 0.2); color: #3b82f6; }
      &.status-completed { background: rgba(16, 185, 129, 0.2); color: #10b981; }
      &.status-cancelled { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
      &.status-timeout { background: rgba(245, 158, 11, 0.2); color: #f59e0b; }
    }

    .action-btn {
      padding: 6px 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 12px;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
      }

      &.primary {
        background: var(--primary-color);
        border-color: var(--primary-color);
        color: white;
      }

      &.danger {
        background: var(--error-color);
        border-color: var(--error-color);
        color: white;
      }
    }

    /* Query Section */
    .query-section {
      padding: var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
      background: var(--bg-tertiary);
    }

    .query-label {
      display: block;
      font-size: 10px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: var(--spacing-xs);
    }

    .query-content {
      font-size: 13px;
      color: var(--text-primary);
      line-height: 1.4;
    }

    /* Progress Section */
    .progress-section {
      display: flex;
      gap: var(--spacing-lg);
      padding: var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
    }

    .round-progress {
      flex: 2;
    }

    .progress-label, .consensus-label {
      display: block;
      font-size: 10px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: var(--spacing-sm);
    }

    .rounds-indicator {
      display: flex;
      align-items: center;
      margin-bottom: var(--spacing-xs);
    }

    .round-dot {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 600;
      transition: all var(--transition-fast);

      &.completed {
        background: var(--primary-color);
        color: white;
      }

      &.current {
        background: var(--primary-color);
        color: white;
        box-shadow: 0 0 0 3px rgba(var(--primary-color-rgb), 0.3);
        animation: pulse 1.5s infinite;
      }

      &.pending {
        background: var(--bg-tertiary);
        color: var(--text-muted);
        border: 2px solid var(--border-color);
      }
    }

    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }

    .round-connector {
      flex: 1;
      height: 3px;
      background: var(--bg-tertiary);
      margin: 0 4px;

      &.completed {
        background: var(--primary-color);
      }
    }

    .round-labels {
      display: flex;
      justify-content: space-between;
      font-size: 9px;
      color: var(--text-muted);
      padding: 0 8px;
    }

    .consensus-display {
      flex: 1;
      display: flex;
      flex-direction: column;
    }

    .consensus-gauge {
      height: 8px;
      background: var(--bg-tertiary);
      border-radius: 4px;
      overflow: hidden;
      margin-bottom: 4px;
    }

    .consensus-fill {
      height: 100%;
      border-radius: 4px;
      transition: width var(--transition-normal);

      &.high { background: linear-gradient(90deg, #10b981, #34d399); }
      &.medium { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
      &.low { background: linear-gradient(90deg, #ef4444, #f87171); }
    }

    .consensus-value {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    /* Rounds Section */
    .rounds-section {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .rounds-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-sm) var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
    }

    .rounds-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .round-tabs {
      display: flex;
      gap: 4px;
    }

    .round-tab {
      padding: 4px 10px;
      background: var(--bg-tertiary);
      border: none;
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 11px;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
      }

      &.active {
        background: var(--primary-color);
        color: white;
      }
    }

    .round-content {
      flex: 1;
      overflow-y: auto;
      padding: var(--spacing-md);
    }

    .round-meta {
      display: flex;
      gap: var(--spacing-md);
      margin-bottom: var(--spacing-md);
    }

    .meta-item {
      font-size: 11px;
      color: var(--text-muted);
    }

    .contributions-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: var(--spacing-md);
    }

    .contribution-card {
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
    }

    .contribution-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--spacing-sm);
    }

    .agent-badge {
      padding: 3px 8px;
      background: var(--primary-color);
      border-radius: var(--radius-sm);
      font-size: 11px;
      font-weight: 600;
      color: white;
    }

    .confidence-badge {
      font-size: 10px;
      color: var(--text-muted);
    }

    .contribution-content {
      font-size: 12px;
      color: var(--text-primary);
      line-height: 1.5;
      margin-bottom: var(--spacing-sm);
    }

    .contribution-reasoning {
      font-size: 11px;
      color: var(--text-secondary);
      padding: var(--spacing-xs);
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      margin-bottom: var(--spacing-sm);
    }

    .reasoning-label {
      font-weight: 600;
      color: var(--text-muted);
    }

    .critiques-section, .defenses-section {
      margin-top: var(--spacing-sm);
      padding-top: var(--spacing-sm);
      border-top: 1px solid var(--border-color);
    }

    .critiques-label, .defenses-label {
      display: block;
      font-size: 10px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: var(--spacing-xs);
    }

    .critique-item {
      padding: var(--spacing-xs);
      border-radius: var(--radius-sm);
      margin-bottom: 4px;
      font-size: 11px;

      &.severity-major {
        background: rgba(239, 68, 68, 0.1);
        border-left: 2px solid #ef4444;
      }

      &.severity-minor {
        background: rgba(245, 158, 11, 0.1);
        border-left: 2px solid #f59e0b;
      }

      &.severity-suggestion {
        background: rgba(59, 130, 246, 0.1);
        border-left: 2px solid #3b82f6;
      }
    }

    .critique-target {
      font-weight: 600;
      color: var(--text-secondary);
      margin-right: var(--spacing-xs);
    }

    .critique-severity {
      padding: 1px 4px;
      border-radius: 2px;
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      margin-right: var(--spacing-xs);
    }

    .critique-issue {
      display: block;
      color: var(--text-primary);
      margin-top: 2px;
    }

    .critique-counter {
      display: block;
      color: var(--text-muted);
      font-style: italic;
      margin-top: 2px;
    }

    .defense-item {
      padding: var(--spacing-xs);
      background: rgba(16, 185, 129, 0.1);
      border-left: 2px solid #10b981;
      border-radius: var(--radius-sm);
      margin-bottom: 4px;
      font-size: 11px;
      color: var(--text-primary);
    }

    /* Result Section */
    .result-section {
      border-top: 1px solid var(--border-color);
      padding: var(--spacing-md);
      background: var(--bg-tertiary);
    }

    .result-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--spacing-md);
    }

    .result-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .consensus-badge {
      padding: 4px 10px;
      border-radius: var(--radius-sm);
      font-size: 11px;
      font-weight: 600;

      &.reached {
        background: rgba(16, 185, 129, 0.2);
        color: #10b981;
      }

      &.not-reached {
        background: rgba(239, 68, 68, 0.2);
        color: #ef4444;
      }
    }

    .synthesis-content {
      padding: var(--spacing-md);
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      font-size: 13px;
      color: var(--text-primary);
      line-height: 1.6;
      margin-bottom: var(--spacing-md);
    }

    .agreements-disagreements {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--spacing-md);
      margin-bottom: var(--spacing-md);
    }

    .agreements-section, .disagreements-section {
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
    }

    .section-label {
      display: block;
      font-size: 10px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: var(--spacing-xs);
    }

    .agreements-list, .disagreements-list {
      margin: 0;
      padding-left: var(--spacing-md);
    }

    .agreement-item {
      font-size: 12px;
      color: #10b981;
      margin-bottom: 4px;
    }

    .disagreement-item {
      font-size: 12px;
      color: #f59e0b;
      margin-bottom: 4px;
    }

    .result-stats {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--spacing-sm);
    }

    .stat-item {
      text-align: center;
      padding: var(--spacing-sm);
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
    }

    .stat-label {
      display: block;
      font-size: 9px;
      color: var(--text-muted);
      margin-bottom: 2px;
    }

    .stat-value {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    /* No Debate State */
    .no-debate {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--spacing-md);
      padding: var(--spacing-xl);
    }

    .no-debate-icon {
      font-size: 48px;
      opacity: 0.5;
    }

    .no-debate-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .no-debate-text {
      font-size: 13px;
      color: var(--text-muted);
      text-align: center;
      max-width: 400px;
    }

    .debate-info {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      margin-top: var(--spacing-md);
    }

    .info-item {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm);
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
    }

    .info-icon {
      font-size: 16px;
    }

    .info-text {
      font-size: 12px;
      color: var(--text-secondary);
    }

    /* Stats Section */
    .stats-section {
      border-top: 1px solid var(--border-color);
      padding: var(--spacing-md);
    }

    .stats-title {
      display: block;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: var(--spacing-sm);
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--spacing-sm);
    }

    .stat-card {
      text-align: center;
      padding: var(--spacing-sm);
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DebateVisualizationComponent {
  /** Active debate */
  activeDebate = input<ActiveDebate | null>(null);

  /** Completed debate result */
  debateResult = input<DebateResult | null>(null);

  /** Debate statistics */
  stats = input<DebateStats | null>(null);

  /** Events */
  startDebate = output<void>();
  cancelDebate = output<void>();

  /** Selected round */
  selectedRound = signal<number>(1);

  getQuery(): string {
    return this.activeDebate()?.query || this.debateResult()?.query || '';
  }

  getCurrentRound(): number {
    return this.activeDebate()?.currentRound || this.debateResult()?.rounds.length || 0;
  }

  getConsensusScore(): number {
    const activeDebate = this.activeDebate();
    if (activeDebate && activeDebate.rounds.length > 0) {
      return activeDebate.rounds[activeDebate.rounds.length - 1].consensusScore;
    }
    return this.debateResult()?.finalConsensusScore || 0;
  }

  getRounds(): DebateSessionRound[] {
    return this.activeDebate()?.rounds || this.debateResult()?.rounds || [];
  }

  getSelectedRoundData(): DebateSessionRound | undefined {
    const rounds = this.getRounds();
    return rounds.find(r => r.roundNumber === this.selectedRound());
  }

  selectRound(roundNumber: number): void {
    this.selectedRound.set(roundNumber);
  }

  getRoundLabel(type: DebateRoundType): string {
    switch (type) {
      case 'initial': return 'Initial';
      case 'critique': return 'Critique';
      case 'defense': return 'Defense';
      case 'synthesis': return 'Synthesis';
      default: return type;
    }
  }

  getAgentIcon(agentId: string): string {
    const icons = ['🤖', '🧠', '🔬', '📊', '💡', '🎯'];
    const hash = agentId.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
    return icons[hash % icons.length];
  }

  formatStatus(status: DebateStatus): string {
    switch (status) {
      case 'pending': return 'Pending';
      case 'in_progress': return 'In Progress';
      case 'completed': return 'Completed';
      case 'cancelled': return 'Cancelled';
      case 'timeout': return 'Timeout';
      default: return status;
    }
  }

  formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  formatNumber(num: number): string {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  }

  truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '...';
  }
}
