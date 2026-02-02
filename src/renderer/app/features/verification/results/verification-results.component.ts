/**
 * Verification Results Component
 *
 * Display verification results:
 * - Synthesized response with confidence
 * - Agent comparison by topic
 * - Consensus heatmap
 * - Export options
 */

import {
  Component,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy
} from '@angular/core';
import { VerificationStore } from '../../../core/state/verification.store';
import { ConsensusHeatmapComponent } from './consensus-heatmap.component';
import { StreamingTextComponent } from '../../../shared/components/streaming-text/streaming-text.component';

type ResultTab = 'summary' | 'comparison' | 'debate' | 'raw' | 'export';

@Component({
  selector: 'app-verification-results',
  standalone: true,
  imports: [ConsensusHeatmapComponent, StreamingTextComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="results-container">
      @if (result(); as r) {
        <!-- Header -->
        <div class="results-header">
          <div class="header-info">
            <h2 class="results-title">Verification Results</h2>
            <div class="results-meta">
              <span>Completed: {{ formatTime(r.completedAt) }}</span>
              <span>Duration: {{ formatDuration(r.totalDuration) }}</span>
              <span>Total Cost: {{ formatCost(r.totalCost) }}</span>
            </div>
          </div>
          <div class="header-actions">
            <button class="action-btn secondary" (click)="exportResults()">
              Export
            </button>
            <button class="action-btn primary" (click)="newVerification()">
              New Verification
            </button>
          </div>
        </div>

        <!-- Tab Navigation -->
        <div class="tab-navigation">
          <button
            class="tab-btn"
            [class.active]="selectedTab() === 'summary'"
            (click)="selectTab('summary')"
          >
            Summary
          </button>
          <button
            class="tab-btn"
            [class.active]="selectedTab() === 'comparison'"
            (click)="selectTab('comparison')"
          >
            Comparison
          </button>
          @if (r.debateRounds && r.debateRounds.length > 0) {
            <button
              class="tab-btn"
              [class.active]="selectedTab() === 'debate'"
              (click)="selectTab('debate')"
            >
              Debate Rounds
            </button>
          }
          <button
            class="tab-btn"
            [class.active]="selectedTab() === 'raw'"
            (click)="selectTab('raw')"
          >
            Raw Responses
          </button>
        </div>

        <!-- Tab Content -->
        <div class="tab-content">
          @switch (selectedTab()) {
            @case ('summary') {
              <!-- Synthesized Result -->
              <section class="section">
                <div class="section-header">
                  <h3 class="section-title">Synthesized Result</h3>
                  <div class="section-actions">
                    <button
                      class="copy-btn"
                      [class.copied]="isCopied('summary')"
                      [disabled]="!r.synthesizedResponse"
                      title="Copy synthesized response"
                      (click)="copyContent('summary', r.synthesizedResponse)"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect
                          x="9"
                          y="9"
                          width="13"
                          height="13"
                          rx="2"
                          ry="2"
                        ></rect>
                        <path
                          d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                        ></path>
                      </svg>
                      <span>{{
                        isCopied('summary') ? 'Copied' : 'Copy Summary'
                      }}</span>
                    </button>
                    <div
                      class="confidence-badge"
                      [class]="getConfidenceClass(r.synthesisConfidence)"
                    >
                      Confidence:
                      {{ ((r.synthesisConfidence || 0) * 100).toFixed(0) }}%
                    </div>
                  </div>
                </div>

                <div class="synthesis-info">
                  <span class="info-label">Method:</span>
                  <span class="info-value">
                    {{ r.synthesisMethod }}
                    @if (r.debateRounds) {
                      ({{ r.debateRounds.length }} rounds)
                    }
                  </span>
                </div>

                <div class="synthesis-content">
                  <app-streaming-text
                    [text]="r.synthesizedResponse || ''"
                    [isStreaming]="false"
                    [options]="{ enableMarkdown: true, showCursor: false, autoScroll: false }"
                  />
                </div>
              </section>

              <!-- Agreement Summary -->
              @if (r.analysis) {
                <section class="section">
                  <div class="section-header">
                    <h3 class="section-title">Agreement Summary</h3>
                    <button
                      class="copy-btn"
                      [class.copied]="isCopied('agreements')"
                      [disabled]="!r.analysis.agreements.length"
                      title="Copy agreement summary"
                      (click)="
                        copyContent(
                          'agreements',
                          formatAgreementsText(r.analysis.agreements)
                        )
                      "
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect
                          x="9"
                          y="9"
                          width="13"
                          height="13"
                          rx="2"
                          ry="2"
                        ></rect>
                        <path
                          d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                        ></path>
                      </svg>
                      <span>{{
                        isCopied('agreements') ? 'Copied' : 'Copy Agreements'
                      }}</span>
                    </button>
                  </div>

                  @if (
                    r.analysis.agreements && r.analysis.agreements.length > 0
                  ) {
                    <div class="agreement-list">
                      @for (
                        agreement of r.analysis.agreements;
                        track agreement.point
                      ) {
                        <div class="agreement-item">
                          <span class="agreement-icon">{{
                            getAgreementIcon(agreement.strength)
                          }}</span>
                          <span class="agreement-text">{{
                            agreement.point
                          }}</span>
                          <span class="agreement-count"
                            >{{ agreement.agentIds.length }} agents</span
                          >
                        </div>
                      }
                    </div>
                  } @else {
                    <p class="empty-text">No strong agreements identified.</p>
                  }
                </section>

                <!-- Consensus Heatmap -->
                <section class="section">
                  <h3 class="section-title">Consensus Heatmap</h3>
                  <app-consensus-heatmap
                    [agents]="getAgentNames()"
                    [matrix]="getConsensusMatrix()"
                  />
                </section>
              }
            }

            @case ('comparison') {
              <!-- Agent Comparison -->
              <section class="section">
                <h3 class="section-title">Agent Comparison</h3>

                <div class="comparison-grid">
                  @for (response of r.responses; track response.agentId) {
                    <div class="comparison-card">
                      <div class="card-header">
                        <span class="agent-name">{{ response.model }}</span>
                        <span class="agent-personality"
                          >({{ formatPersonality(response.personality) }})</span
                        >
                        <button
                          class="copy-btn compact"
                          [class.copied]="
                            isCopied('comparison-' + response.agentId)
                          "
                          [disabled]="!response.response"
                          title="Copy full response"
                          (click)="
                            copyContent(
                              'comparison-' + response.agentId,
                              response.response
                            )
                          "
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <rect
                              x="9"
                              y="9"
                              width="13"
                              height="13"
                              rx="2"
                              ry="2"
                            ></rect>
                            <path
                              d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                            ></path>
                          </svg>
                          <span>{{
                            isCopied('comparison-' + response.agentId)
                              ? 'Copied'
                              : 'Copy'
                          }}</span>
                        </button>
                      </div>

                      <div class="card-confidence">
                        Confidence:
                        {{ ((response.confidence || 0) * 100).toFixed(0) }}%
                      </div>

                      @if (
                        response.keyPoints && response.keyPoints.length > 0
                      ) {
                        <div class="key-points">
                          <h4>Key Points</h4>
                          <ul>
                            @for (point of response.keyPoints; track point.id) {
                              <li>
                                <span class="point-category"
                                  >[{{ point.category }}]</span
                                >
                                {{ point.content }}
                              </li>
                            }
                          </ul>
                        </div>
                      } @else if (response.response) {
                        <div class="response-preview">
                          <p>{{ truncateResponse(response.response) }}</p>
                        </div>
                      }

                      <div class="card-meta">
                        <span>{{ response.tokens || 0 }} tokens</span>
                        <span>{{ formatCost(response.cost || 0) }}</span>
                        <span>{{
                          formatDuration(response.duration || 0)
                        }}</span>
                      </div>
                    </div>
                  }
                </div>
              </section>
            }

            @case ('debate') {
              <!-- Debate Rounds -->
              @if (r.debateRounds) {
                <section class="section">
                  <div class="round-selector">
                    @for (
                      round of r.debateRounds;
                      track round.roundNumber;
                      let i = $index
                    ) {
                      <button
                        class="round-btn"
                        [class.active]="selectedRound() === i"
                        (click)="selectRound(i)"
                      >
                        Round {{ round.roundNumber }}:
                        {{ getRoundLabel(round.type) }}
                      </button>
                    }
                  </div>

                  @if (currentRound(); as round) {
                    <div class="round-info">
                      <div class="round-meta">
                        <div class="round-meta-items">
                          <span
                            >Consensus:
                            {{
                              ((round.consensusScore || 0) * 100).toFixed(0)
                            }}%</span
                          >
                          <span
                            >Duration:
                            {{ formatDuration(round.durationMs) }}</span
                          >
                        </div>
                        <button
                          class="copy-btn compact"
                          [class.copied]="
                            isCopied('round-' + round.roundNumber)
                          "
                          title="Copy round details"
                          (click)="
                            copyContent(
                              'round-' + round.roundNumber,
                              formatRoundText(round)
                            )
                          "
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <rect
                              x="9"
                              y="9"
                              width="13"
                              height="13"
                              rx="2"
                              ry="2"
                            ></rect>
                            <path
                              d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                            ></path>
                          </svg>
                          <span>{{
                            isCopied('round-' + round.roundNumber)
                              ? 'Copied'
                              : 'Copy Round'
                          }}</span>
                        </button>
                      </div>

                      <div class="contributions">
                        @for (
                          contrib of round.contributions;
                          track contrib.agentId
                        ) {
                          <div class="contribution-card">
                            <div class="contrib-header">
                              <span class="agent-name">{{
                                contrib.agentId
                              }}</span>
                            </div>
                            <div class="contrib-content">
                              {{ contrib.content }}
                            </div>
                            @if (
                              contrib.critiques && contrib.critiques.length > 0
                            ) {
                              <div class="critiques">
                                <h5>Critiques:</h5>
                                @for (
                                  critique of contrib.critiques;
                                  track critique.targetAgentId
                                ) {
                                  <div class="critique-item">
                                    <span class="critique-target"
                                      >Re: {{ critique.targetAgentId }}</span
                                    >
                                    <p>{{ critique.issue }}</p>
                                  </div>
                                }
                              </div>
                            }
                          </div>
                        }
                      </div>
                    </div>
                  }
                </section>
              }
            }

            @case ('raw') {
              <!-- Raw Responses -->
              <section class="section">
                <h3 class="section-title">Raw Agent Responses</h3>

                @for (response of r.responses; track response.agentId) {
                  <div class="raw-response">
                    <div class="response-header">
                      <span class="agent-name">{{ response.model }}</span>
                      <span class="agent-personality"
                        >({{ formatPersonality(response.personality) }})</span
                      >
                      <button
                        class="copy-btn compact"
                        [class.copied]="isCopied('raw-' + response.agentId)"
                        [disabled]="!response.response"
                        title="Copy raw response"
                        (click)="
                          copyContent(
                            'raw-' + response.agentId,
                            response.response
                          )
                        "
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <rect
                            x="9"
                            y="9"
                            width="13"
                            height="13"
                            rx="2"
                            ry="2"
                          ></rect>
                          <path
                            d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                          ></path>
                        </svg>
                        <span>{{
                          isCopied('raw-' + response.agentId)
                            ? 'Copied'
                            : 'Copy'
                        }}</span>
                      </button>
                    </div>
                    <pre class="response-content">{{ response.response }}</pre>
                  </div>
                }
              </section>
            }
          }
        </div>
      } @else {
        <div class="empty-state">
          <p>No verification results available.</p>
          <button class="action-btn primary" (click)="newVerification()">
            Start New Verification
          </button>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .results-container {
        display: flex;
        flex-direction: column;
        gap: 20px;
      }

      .results-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        background: var(--bg-secondary);
        border-radius: 8px;
        padding: 16px;
        border: 1px solid var(--border-color);
      }

      .results-title {
        font-size: 18px;
        font-weight: 600;
        margin: 0 0 8px 0;
      }

      .results-meta {
        display: flex;
        gap: 20px;
        font-size: 13px;
        color: var(--text-secondary);
      }

      .header-actions {
        display: flex;
        gap: 8px;
      }

      .action-btn {
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        border: none;
      }

      .action-btn.primary {
        background: var(--accent-color, #3b82f6);
        color: white;
      }

      .action-btn.primary:hover {
        background: var(--accent-hover, #2563eb);
      }

      .action-btn.secondary {
        background: var(--bg-tertiary);
        color: var(--text-primary);
        border: 1px solid var(--border-color);
      }

      .action-btn.secondary:hover {
        background: var(--bg-hover);
      }

      .tab-navigation {
        display: flex;
        gap: 4px;
        background: var(--bg-secondary);
        padding: 8px;
        border-radius: 8px;
        border: 1px solid var(--border-color);
      }

      .tab-btn {
        padding: 8px 16px;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        border-radius: 6px;
      }

      .tab-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      .tab-btn.active {
        background: var(--accent-color, #3b82f6);
        color: white;
      }

      .tab-content {
        display: flex;
        flex-direction: column;
        gap: 20px;
      }

      .section {
        background: var(--bg-secondary);
        border-radius: 8px;
        padding: 16px;
        border: 1px solid var(--border-color);
      }

      .section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 16px;
      }

      .section-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .section-title {
        font-size: 14px;
        font-weight: 600;
        margin: 0;
      }

      .confidence-badge {
        padding: 4px 12px;
        border-radius: 16px;
        font-size: 13px;
        font-weight: 500;
      }

      .copy-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 6px;
        border: 1px solid var(--border-color);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 12px;
        cursor: pointer;
        transition:
          background 0.15s ease,
          color 0.15s ease,
          border-color 0.15s ease;
      }

      .copy-btn.compact {
        padding: 4px 8px;
      }

      .copy-btn svg {
        width: 14px;
        height: 14px;
        stroke: currentColor;
        stroke-width: 2;
        fill: none;
        flex-shrink: 0;
      }

      .copy-btn:hover:not(:disabled) {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      .copy-btn.copied {
        background: rgba(34, 197, 94, 0.12);
        color: #16a34a;
        border-color: rgba(34, 197, 94, 0.4);
      }

      .copy-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .confidence-badge.high {
        background: rgba(34, 197, 94, 0.1);
        color: #22c55e;
      }

      .confidence-badge.medium {
        background: rgba(245, 158, 11, 0.1);
        color: #f59e0b;
      }

      .confidence-badge.low {
        background: rgba(239, 68, 68, 0.1);
        color: #ef4444;
      }

      .synthesis-info {
        font-size: 13px;
        margin-bottom: 12px;
        color: var(--text-secondary);
      }

      .info-label {
        font-weight: 500;
      }

      .synthesis-content {
        font-size: 15px;
        line-height: 1.7;
      }

      .agreement-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .agreement-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 12px;
        background: var(--bg-primary);
        border-radius: 6px;
      }

      .agreement-icon {
        font-size: 18px;
      }

      .agreement-text {
        flex: 1;
        font-size: 14px;
      }

      .agreement-count {
        font-size: 12px;
        color: var(--text-secondary);
      }

      .comparison-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        gap: 16px;
      }

      .comparison-card {
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 16px;
      }

      .card-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }

      .card-header .copy-btn {
        margin-left: auto;
      }

      .agent-name {
        font-weight: 600;
      }

      .agent-personality {
        font-size: 13px;
        color: var(--text-secondary);
      }

      .card-confidence {
        font-size: 13px;
        color: var(--text-secondary);
        margin-bottom: 12px;
      }

      .key-points {
        margin-bottom: 12px;
      }

      .key-points h4 {
        font-size: 13px;
        font-weight: 600;
        margin: 0 0 8px 0;
      }

      .key-points ul {
        margin: 0;
        padding-left: 20px;
        font-size: 13px;
      }

      .key-points li {
        margin-bottom: 4px;
      }

      .point-category {
        color: var(--accent-color, #3b82f6);
        font-weight: 500;
      }

      .response-preview {
        font-size: 13px;
        color: var(--text-secondary);
        line-height: 1.5;
        margin-bottom: 12px;
      }

      .response-preview p {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .card-meta {
        display: flex;
        gap: 16px;
        font-size: 12px;
        color: var(--text-secondary);
        padding-top: 12px;
        border-top: 1px solid var(--border-color);
      }

      .round-selector {
        display: flex;
        gap: 4px;
        margin-bottom: 16px;
        flex-wrap: wrap;
      }

      .round-btn {
        padding: 6px 12px;
        border: 1px solid var(--border-color);
        background: var(--bg-primary);
        color: var(--text-secondary);
        font-size: 13px;
        border-radius: 4px;
        cursor: pointer;
      }

      .round-btn:hover {
        background: var(--bg-hover);
      }

      .round-btn.active {
        background: var(--accent-color, #3b82f6);
        color: white;
        border-color: var(--accent-color, #3b82f6);
      }

      .round-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 13px;
        color: var(--text-secondary);
        margin-bottom: 16px;
      }

      .round-meta-items {
        display: flex;
        gap: 20px;
        align-items: center;
      }

      .contributions {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .contribution-card {
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 16px;
      }

      .contrib-header {
        margin-bottom: 8px;
      }

      .contrib-content {
        font-size: 14px;
        line-height: 1.6;
        margin-bottom: 12px;
      }

      .critiques h5 {
        font-size: 13px;
        margin: 0 0 8px 0;
      }

      .critique-item {
        background: var(--bg-secondary);
        padding: 8px 12px;
        border-radius: 4px;
        margin-bottom: 8px;
      }

      .critique-target {
        font-size: 12px;
        font-weight: 500;
        color: var(--accent-color, #3b82f6);
      }

      .critique-item p {
        margin: 4px 0 0 0;
        font-size: 13px;
      }

      .raw-response {
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        margin-bottom: 16px;
        overflow: hidden;
      }

      .response-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 16px;
        background: var(--bg-tertiary);
        border-bottom: 1px solid var(--border-color);
      }

      .response-header .copy-btn {
        margin-left: auto;
      }

      .response-content {
        padding: 16px;
        margin: 0;
        font-size: 13px;
        line-height: 1.6;
        white-space: pre-wrap;
        font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
        max-height: 400px;
        overflow-y: auto;
      }

      .empty-state {
        text-align: center;
        padding: 48px;
        color: var(--text-secondary);
      }

      .empty-text {
        color: var(--text-secondary);
        font-size: 14px;
      }
    `
  ]
})
export class VerificationResultsComponent {
  store = inject(VerificationStore);

  // UI State
  selectedTab = signal<ResultTab>('summary');
  selectedRound = signal<number>(0);
  copiedKey = signal<string | null>(null);

  // Computed
  result = computed(() => this.store.result());

  currentRound = computed(() => {
    const r = this.result();
    if (!r?.debateRounds) return null;
    return r.debateRounds[this.selectedRound()];
  });

  // ============================================
  // Tab Navigation
  // ============================================

  selectTab(tab: ResultTab): void {
    this.selectedTab.set(tab);
  }

  selectRound(index: number): void {
    this.selectedRound.set(index);
  }

  // ============================================
  // Formatting
  // ============================================

  formatTime(timestamp?: number): string {
    if (!timestamp) return 'Unknown';
    return new Date(timestamp).toLocaleString();
  }

  formatDuration(ms?: number): string {
    if (!ms) return '0s';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }

  formatCost(cost?: number): string {
    return `$${(cost || 0).toFixed(4)}`;
  }

  formatPersonality(personality?: string): string {
    if (!personality) return 'Default';
    return personality
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  truncateResponse(response: string, maxLength = 300): string {
    if (!response) return '';
    if (response.length <= maxLength) return response;
    return response.slice(0, maxLength).trim() + '...';
  }

  getConfidenceClass(confidence?: number): string {
    if (!confidence) return 'low';
    if (confidence >= 0.8) return 'high';
    if (confidence >= 0.5) return 'medium';
    return 'low';
  }

  getAgreementIcon(strength?: number): string {
    if (!strength) return '❓';
    if (strength >= 0.8) return '✓';
    if (strength >= 0.5) return '⚠';
    return '✗';
  }

  getRoundLabel(type?: string): string {
    const labels: Record<string, string> = {
      independent: 'Independent',
      critique: 'Critique',
      defense: 'Defense',
      synthesis: 'Synthesis'
    };
    return labels[type || ''] || type || 'Unknown';
  }

  formatAgreementsText(
    agreements?: {
      point: string;
      category: string;
      agentIds: string[];
      strength: number;
      combinedConfidence: number;
    }[]
  ): string {
    if (!agreements || agreements.length === 0) return '';

    return agreements
      .map((agreement, index) => {
        const strength = `${Math.round((agreement.strength || 0) * 100)}%`;
        const confidence = `${Math.round((agreement.combinedConfidence || 0) * 100)}%`;
        const agents = agreement.agentIds?.length
          ? agreement.agentIds.join(', ')
          : 'Unknown';
        return [
          `${index + 1}. [${agreement.category}] ${agreement.point}`,
          `Strength: ${strength} | Confidence: ${confidence} | Agents: ${agents}`
        ].join('\n');
      })
      .join('\n\n');
  }

  formatRoundText(round: {
    roundNumber: number;
    type?: string;
    consensusScore?: number;
    durationMs?: number;
    contributions: {
      agentId: string;
      content: string;
      critiques?: {
        targetAgentId: string;
        issue: string;
        severity?: string;
      }[];
    }[];
  }): string {
    const header = [
      `Round ${round.roundNumber}: ${this.getRoundLabel(round.type)}`,
      `Consensus: ${Math.round((round.consensusScore || 0) * 100)}%`,
      `Duration: ${this.formatDuration(round.durationMs)}`
    ].join('\n');

    const contributions = round.contributions
      .map((contrib) => {
        const crits =
          contrib.critiques && contrib.critiques.length > 0
            ? `Critiques:\n${contrib.critiques
                .map((critique) => {
                  const severity = critique.severity
                    ? ` (${critique.severity})`
                    : '';
                  return `- Re: ${critique.targetAgentId}${severity}: ${critique.issue}`;
                })
                .join('\n')}`
            : '';

        return [`${contrib.agentId}:`, contrib.content, crits]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n');

    return `${header}\n\n${contributions}`.trim();
  }

  isCopied(key: string): boolean {
    return this.copiedKey() === key;
  }

  copyContent(key: string, content?: string): void {
    if (!content) return;

    navigator.clipboard
      .writeText(content)
      .then(() => {
        this.copiedKey.set(key);
        setTimeout(() => {
          if (this.copiedKey() === key) {
            this.copiedKey.set(null);
          }
        }, 2000);
      })
      .catch((err) => {
        console.error('Failed to copy content:', err);
      });
  }

  // ============================================
  // Consensus Heatmap Data
  // ============================================

  getAgentNames(): { id: string; name: string }[] {
    const r = this.result();
    if (!r?.responses) return [];
    return r.responses.map((response) => ({
      id: response.agentId,
      name: response.model.split(':').pop() || response.model
    }));
  }

  getConsensusMatrix(): number[][] {
    const r = this.result();
    if (!r?.responses) return [];

    // Build a simple consensus matrix based on shared key points
    const agents = r.responses;
    const n = agents.length;
    const matrix: number[][] = Array.from({ length: n }, () =>
      Array(n).fill(0)
    );

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) {
          matrix[i][j] = 1;
        } else {
          // Calculate similarity based on confidence and key points overlap
          const pointsI = new Set(
            (agents[i].keyPoints || []).map(
              (p) => p.content?.toLowerCase() || ''
            )
          );
          const pointsJ = new Set(
            (agents[j].keyPoints || []).map(
              (p) => p.content?.toLowerCase() || ''
            )
          );

          let overlap = 0;
          pointsI.forEach((p) => {
            if (pointsJ.has(p)) overlap++;
          });

          const similarity =
            pointsI.size > 0 || pointsJ.size > 0
              ? (overlap * 2) / (pointsI.size + pointsJ.size)
              : 0.5;

          // Factor in confidence
          const confSim =
            1 -
            Math.abs(
              (agents[i].confidence || 0.5) - (agents[j].confidence || 0.5)
            );

          matrix[i][j] = (similarity + confSim) / 2;
        }
      }
    }

    return matrix;
  }

  // ============================================
  // Actions
  // ============================================

  newVerification(): void {
    this.store.setSelectedTab('dashboard');
  }

  exportResults(): void {
    const r = this.result();
    if (!r) return;

    const content = JSON.stringify(r, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `verification-${r.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
