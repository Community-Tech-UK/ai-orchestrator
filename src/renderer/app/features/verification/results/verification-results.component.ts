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
import { CLIPBOARD_SERVICE } from '../../../core/services/clipboard.service';
import type { VerdictStatus } from '../../../../../shared/types/verification.types';

type ResultTab = 'summary' | 'comparison' | 'debate' | 'raw' | 'export';

@Component({
  selector: 'app-verification-results',
  standalone: true,
  imports: [ConsensusHeatmapComponent, StreamingTextComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './verification-results.component.html',
  styleUrl: './verification-results.component.scss',
})
export class VerificationResultsComponent {
  store = inject(VerificationStore);
  private clipboard = inject(CLIPBOARD_SERVICE);

  // UI State
  selectedTab = signal<ResultTab>('summary');
  selectedRound = signal<number>(0);
  copiedKey = signal<string | null>(null);

  // Computed
  result = computed(() => this.store.result());
  verdict = computed(() => this.store.currentVerdict());

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

  getVerdictLabel(status: VerdictStatus): string {
    switch (status) {
      case 'pass':
        return 'Pass';
      case 'pass-with-notes':
        return 'Pass with notes';
      case 'needs-changes':
        return 'Needs changes';
      case 'blocked':
        return 'Blocked';
      case 'inconclusive':
        return 'Inconclusive';
    }
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

  async copyContent(key: string, content?: string): Promise<void> {
    if (!content) return;

    const result = await this.clipboard.copyText(content, { label: 'verification response' });
    if (result.ok) {
      this.copiedKey.set(key);
      setTimeout(() => {
        if (this.copiedKey() === key) {
          this.copiedKey.set(null);
        }
      }, 2000);
    } else {
      console.error('Failed to copy content:', result.reason, result.cause);
    }
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
