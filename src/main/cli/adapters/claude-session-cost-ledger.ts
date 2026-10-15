/** Dollar totals include subagents; settlement occurs once at completion, never during parsing. */
export class ClaudeSessionCostLedger {
  private previous?: number;
  private first = true;
  private mode: 'fresh' | 'fork' | 'resume' = 'fresh';
  get lastTotalUsd(): number | undefined { return this.previous; }
  onSpawn(mode: 'fresh' | 'fork' | 'resume', seedTotalUsd?: number): void {
    this.mode = mode; this.first = true;
    this.previous = mode === 'resume' && typeof seedTotalUsd === 'number' && Number.isFinite(seedTotalUsd) && seedTotalUsd >= 0 ? seedTotalUsd : undefined;
  }
  settle(reportedTotalUsd: number | undefined, mainThreadPricedUsd: number | undefined): number | undefined {
    if (typeof reportedTotalUsd !== 'number' || !Number.isFinite(reportedTotalUsd) || reportedTotalUsd < 0) return undefined;
    const previous = this.previous;
    const first = this.first;
    this.previous = reportedTotalUsd; this.first = false;
    if (first && this.mode === 'resume') {
      if (previous === undefined) return undefined;
      const delta = reportedTotalUsd - previous;
      return delta < 0 || delta < 0.8 * (mainThreadPricedUsd ?? 0) ? reportedTotalUsd : delta;
    }
    return previous === undefined || reportedTotalUsd < previous ? reportedTotalUsd : reportedTotalUsd - previous;
  }
}
