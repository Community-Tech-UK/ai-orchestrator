/**
 * Compaction Epoch Tracker - turn IDs across compaction boundaries.
 * Inspired by Claude Code's AutoCompactTrackingState.
 */

import { randomBytes } from 'crypto';

export interface CompactionEpoch {
  epochId: string;
  turnCount: number;
  startedAt: number;
}

export interface CompactionRecord {
  epochId: string;
  turnsBeforeCompaction: number;
  timestamp: number;
}

const MAX_HISTORY = 100;

export class CompactionEpochTracker {
  private currentEpoch: CompactionEpoch;
  private history: CompactionRecord[] = [];

  constructor() {
    this.currentEpoch = { epochId: this.generateId(), turnCount: 0, startedAt: Date.now() };
  }

  getCurrentEpoch(): CompactionEpoch { return { ...this.currentEpoch }; }

  incrementTurn(): void { this.currentEpoch.turnCount++; }

  onCompaction(): void {
    this.history.push({
      epochId: this.currentEpoch.epochId,
      turnsBeforeCompaction: this.currentEpoch.turnCount,
      timestamp: Date.now(),
    });
    if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY);
    this.currentEpoch = { epochId: this.generateId(), turnCount: 0, startedAt: Date.now() };
  }

  getHistory(): CompactionRecord[] { return [...this.history]; }

  getAverageTurnsBetweenCompactions(): number {
    if (this.history.length === 0) return 0;
    const total = this.history.reduce((sum, r) => sum + r.turnsBeforeCompaction, 0);
    return Math.round(total / this.history.length);
  }

  private generateId(): string { return randomBytes(8).toString('base64url'); }
}
