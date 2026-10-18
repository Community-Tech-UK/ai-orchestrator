/**
 * Verification Monitor Component
 *
 * Real-time progress view during verification:
 * - Agent progress bars
 * - Streaming response display
 * - Round timeline
 * - Live consensus score
 */

import {
  Component,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { VerificationStore } from '../../../core/state/verification.store';
import type { VerificationCost } from '../../../../../shared/types/verification.types';

@Component({
  selector: 'app-verification-monitor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="monitor-container">
      <!-- Header Info -->
      <div class="monitor-header">
        <div class="prompt-display">
          <span class="prompt-label">Prompt:</span>
          <span class="prompt-text">{{ store.currentSession()?.prompt }}</span>
        </div>
        <div class="meta-row">
          <span class="meta-item">
            Strategy: {{ store.currentSession()?.config?.synthesisStrategy }}
            @if (store.roundInfo().total > 1) {
              (Round {{ store.roundInfo().current }} of {{ store.roundInfo().total }})
            }
          </span>
          <span class="meta-item">Elapsed: {{ formatElapsed() }}</span>
        </div>
      </div>

      <!-- Cancel Button -->
      <div class="actions-row">
        <button
          class="action-btn danger"
          (click)="cancelVerification()"
          [disabled]="!store.isRunning()"
        >
          Cancel Verification
        </button>
      </div>

      <!-- Agent Progress -->
      <section class="section">
        <h3 class="section-title">Agent Progress</h3>

        <div class="progress-list">
          @for (agent of store.agentProgressList(); track agent.agentId) {
            <div class="agent-progress">
              <div class="progress-header">
                <span class="agent-name">{{ agent.name }}</span>
                <span class="agent-personality">({{ formatPersonality(agent.personality) }})</span>
                <span class="progress-percent">{{ agent.progress }}%</span>
              </div>

              <div class="progress-bar">
                <div
                  class="progress-fill"
                  [style.width.%]="agent.progress"
                  [class.complete]="agent.status === 'complete'"
                  [class.error]="agent.status === 'error'"
                  [class.running]="agent.status === 'running'"
                ></div>
              </div>

              <div class="progress-meta">
                <span class="status-badge" [class]="'status-' + agent.status">
                  @if (agent.status === 'running') {
                    {{ agent.currentActivity || 'Processing...' }}
                  } @else if (agent.status === 'complete') {
                    Complete
                  } @else if (agent.status === 'error') {
                    Error
                  } @else {
                    Pending
                  }
                </span>
                @if (agent.tokens > 0) {
                  <span class="token-count">{{ agent.tokens }} tokens</span>
                }
              </div>
            </div>
          }
        </div>
      </section>

      <!-- Live Responses -->
      <section class="section">
        <h3 class="section-title">Live Responses</h3>

        <div class="response-tabs">
          @for (agent of store.agentProgressList(); track agent.agentId) {
            <button
              class="response-tab"
              [class.active]="selectedAgentId() === agent.agentId"
              (click)="selectAgent(agent.agentId)"
            >
              {{ agent.name }}
            </button>
          }
          <button
            class="response-tab"
            [class.active]="selectedAgentId() === 'all'"
            (click)="selectAgent('all')"
          >
            All Streams
          </button>
        </div>

        <div class="response-content">
          @if (selectedAgentId() === 'all') {
            @if (hasAnyStreamedContent()) {
              @for (agent of store.agentProgressList(); track agent.agentId) {
                @if (agent.streamedContent) {
                  <div class="stream-block">
                    <div class="stream-header">
                      {{ agent.name }} ({{ formatPersonality(agent.personality) }})
                    </div>
                    <div class="stream-text">{{ agent.streamedContent }}</div>
                  </div>
                }
              }
            } @else {
              <div class="empty-streams">
                <p>Waiting for agent responses...</p>
                <p class="hint">Responses will appear here as agents stream their output.</p>
              </div>
            }
          } @else {
            @if (selectedAgent(); as agent) {
              <div class="stream-block solo">
                <div class="stream-header">
                  {{ agent.name }} ({{ formatPersonality(agent.personality) }})
                </div>
                <div class="stream-text">
                  {{ agent.streamedContent || 'Waiting for response...' }}
                  @if (agent.status === 'running') {
                    <span class="cursor"></span>
                  }
                </div>
                <div class="stream-meta">
                  Tokens: {{ agent.tokens }} | Cost: {{ formatCost(agent.cost) }}
                </div>
              </div>
            }
          }
        </div>
      </section>

      <!-- Round Timeline -->
      @if (store.roundInfo().total > 1) {
        <section class="section">
          <h3 class="section-title">Debate Timeline</h3>

          <div class="timeline">
            @for (round of rounds(); track round.number) {
              <div class="timeline-item">
                <div
                  class="timeline-dot"
                  [class.completed]="store.roundInfo().current > round.number"
                  [class.current]="store.roundInfo().current === round.number"
                  [class.pending]="store.roundInfo().current < round.number"
                >
                  {{ round.number }}
                </div>
                <div class="timeline-label">{{ round.label }}</div>
                <div class="timeline-status">
                  @if (store.roundInfo().current > round.number) {
                    Complete
                  } @else if (store.roundInfo().current === round.number) {
                    In Progress
                  } @else {
                    Pending
                  }
                </div>
              </div>
              @if (round.number < store.roundInfo().total) {
                <div
                  class="timeline-connector"
                  [class.completed]="store.roundInfo().current > round.number"
                ></div>
              }
            }
          </div>
        </section>
      }

      <!-- Live Consensus -->
      <section class="section">
        <h3 class="section-title">Live Consensus</h3>

        <div class="consensus-display">
          <div class="consensus-bar">
            <div
              class="consensus-fill"
              [style.width.%]="store.consensusScore() * 100"
              [class.high]="store.consensusScore() >= 0.8"
              [class.medium]="store.consensusScore() >= 0.5 && store.consensusScore() < 0.8"
              [class.low]="store.consensusScore() < 0.5"
            ></div>
          </div>
          <span class="consensus-value">
            Current Agreement: {{ (store.consensusScore() * 100).toFixed(0) }}%
          </span>
        </div>
      </section>
    </div>
  `,
  styles: [`
    .monitor-container {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .monitor-header {
      background: var(--bg-secondary);
      border-radius: 8px;
      padding: 16px;
      border: 1px solid var(--border-color);
    }

    .prompt-display {
      margin-bottom: 8px;
    }

    .prompt-label {
      font-size: 13px;
      color: var(--text-secondary);
      margin-right: 8px;
    }

    .prompt-text {
      font-size: 15px;
      font-weight: 500;
    }

    .meta-row {
      display: flex;
      gap: 24px;
      font-size: 13px;
      color: var(--text-secondary);
    }

    .actions-row {
      display: flex;
      justify-content: flex-end;
    }

    .action-btn {
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      border: none;
    }

    .action-btn.danger {
      background: rgba(239, 68, 68, 0.1);
      color: #ef4444;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }

    .action-btn.danger:hover:not(:disabled) {
      background: rgba(239, 68, 68, 0.2);
    }

    .action-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .section {
      background: var(--bg-secondary);
      border-radius: 8px;
      padding: 16px;
      border: 1px solid var(--border-color);
    }

    .section-title {
      font-size: 14px;
      font-weight: 600;
      margin: 0 0 16px 0;
      color: var(--text-primary);
    }

    .progress-list {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .agent-progress {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .progress-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .agent-name {
      font-weight: 500;
    }

    .agent-personality {
      font-size: 13px;
      color: var(--text-secondary);
    }

    .progress-percent {
      margin-left: auto;
      font-size: 13px;
      font-weight: 500;
      color: var(--accent-color, #3b82f6);
    }

    .progress-bar {
      height: 8px;
      background: var(--bg-tertiary);
      border-radius: 4px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.3s ease;
    }

    .progress-fill.running {
      background: var(--accent-color, #3b82f6);
    }

    .progress-fill.complete {
      background: #22c55e;
    }

    .progress-fill.error {
      background: #ef4444;
    }

    .progress-meta {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 12px;
    }

    .status-badge {
      padding: 2px 8px;
      border-radius: 4px;
    }

    .status-badge.status-running {
      background: rgba(59, 130, 246, 0.1);
      color: #3b82f6;
    }

    .status-badge.status-complete {
      background: rgba(34, 197, 94, 0.1);
      color: #22c55e;
    }

    .status-badge.status-error {
      background: rgba(239, 68, 68, 0.1);
      color: #ef4444;
    }

    .status-badge.status-pending {
      background: var(--bg-tertiary);
      color: var(--text-secondary);
    }

    .token-count {
      color: var(--text-secondary);
    }

    .response-tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }

    .response-tab {
      padding: 6px 12px;
      border: none;
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      font-size: 13px;
      border-radius: 4px;
      cursor: pointer;
    }

    .response-tab:hover {
      background: var(--bg-hover);
    }

    .response-tab.active {
      background: var(--accent-color, #3b82f6);
      color: white;
    }

    .response-content {
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-height: 400px;
      overflow-y: auto;
    }

    .stream-block {
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 12px;
    }

    .stream-block.solo {
      min-height: 200px;
    }

    .stream-header {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-secondary);
      margin-bottom: 8px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border-color);
    }

    .stream-text {
      font-size: 14px;
      line-height: 1.6;
      white-space: pre-wrap;
      font-family: inherit;
    }

    .cursor {
      display: inline-block;
      width: 8px;
      height: 16px;
      background: var(--accent-color, #3b82f6);
      animation: blink 1s step-end infinite;
      vertical-align: text-bottom;
      margin-left: 2px;
    }

    @keyframes blink {
      50% { opacity: 0; }
    }

    .stream-meta {
      margin-top: 12px;
      padding-top: 8px;
      border-top: 1px solid var(--border-color);
      font-size: 12px;
      color: var(--text-secondary);
    }

    .empty-streams {
      text-align: center;
      padding: 40px 20px;
      color: var(--text-secondary);
    }

    .empty-streams p {
      margin: 0 0 8px 0;
    }

    .empty-streams .hint {
      font-size: 13px;
      color: var(--text-muted);
    }

    .timeline {
      display: flex;
      align-items: flex-start;
      gap: 0;
    }

    .timeline-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      flex: 1;
    }

    .timeline-dot {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 8px;
    }

    .timeline-dot.completed {
      background: #22c55e;
      color: white;
    }

    .timeline-dot.current {
      background: var(--accent-color, #3b82f6);
      color: white;
      animation: pulse 1.5s infinite;
    }

    .timeline-dot.pending {
      background: var(--bg-tertiary);
      color: var(--text-secondary);
    }

    .timeline-label {
      font-size: 13px;
      font-weight: 500;
      text-align: center;
    }

    .timeline-status {
      font-size: 11px;
      color: var(--text-secondary);
    }

    .timeline-connector {
      width: 100%;
      height: 2px;
      background: var(--bg-tertiary);
      margin-top: 16px;
      flex: 1;
    }

    .timeline-connector.completed {
      background: #22c55e;
    }

    .consensus-display {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .consensus-bar {
      height: 24px;
      background: var(--bg-tertiary);
      border-radius: 12px;
      overflow: hidden;
    }

    .consensus-fill {
      height: 100%;
      border-radius: 12px;
      transition: width 0.5s ease;
    }

    .consensus-fill.high {
      background: #22c55e;
    }

    .consensus-fill.medium {
      background: #f59e0b;
    }

    .consensus-fill.low {
      background: #ef4444;
    }

    .consensus-value {
      font-size: 14px;
      font-weight: 500;
    }
  `],
})
export class VerificationMonitorComponent {
  store = inject(VerificationStore);

  // UI State
  selectedAgentId = signal<string>('all');
  startTime = Date.now();

  // Computed
  rounds = computed(() => {
    const total = this.store.roundInfo().total;
    const labels = ['Independent', 'Critique', 'Defense', 'Synthesis', 'Final', 'Extra'];
    return Array.from({ length: total }, (_, i) => ({
      number: i + 1,
      label: labels[i] || `Round ${i + 1}`,
    }));
  });

  selectedAgent = computed(() => {
    const id = this.selectedAgentId();
    if (id === 'all') return null;
    return this.store.agentProgressList().find(a => a.agentId === id);
  });

  hasAnyStreamedContent = computed(() => {
    return this.store.agentProgressList().some(a => a.streamedContent);
  });

  // ============================================
  // Helpers
  // ============================================

  formatElapsed(): string {
    const session = this.store.currentSession();
    if (!session) return '0:00';

    const elapsed = Math.floor((Date.now() - session.startedAt) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  formatPersonality(personality?: string): string {
    if (!personality) return 'Default';
    return personality
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  formatCost(cost: VerificationCost): string {
    return cost === 'unknown' ? 'Unknown' : `$${cost.toFixed(4)}`;
  }

  // ============================================
  // Actions
  // ============================================

  selectAgent(agentId: string): void {
    this.selectedAgentId.set(agentId);
  }

  cancelVerification(): void {
    this.store.cancelVerification();
  }
}
