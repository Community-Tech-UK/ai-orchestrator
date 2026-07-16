export interface CodexTurnCostSample {
  cumulativeTokens: number;
  contextWindow: number;
}

export interface CodexTurnCostObservation {
  spendSinceCompaction: number;
  contextWindow: number;
  multiple: number;
  counterResetObserved: boolean;
}

/**
 * Codex-specific cumulative-counter telemetry.
 *
 * Thresholds intentionally do not live here. The provider-neutral
 * ContextSafetyPolicy is the sole decision owner; this class only normalizes
 * provider observations and detects proof of a native counter reset.
 */
export class CodexTurnCostGovernor {
  private cumulativeBaseline = 0;
  private lastCumulativeTokens: number | null = null;

  observe(sample: CodexTurnCostSample): CodexTurnCostObservation {
    if (
      !Number.isFinite(sample.cumulativeTokens)
      || sample.cumulativeTokens < 0
      || !Number.isFinite(sample.contextWindow)
      || sample.contextWindow <= 0
    ) {
      return this.observation(0, sample.contextWindow, false);
    }

    const counterResetObserved = this.lastCumulativeTokens !== null
      && sample.cumulativeTokens < this.lastCumulativeTokens;
    if (counterResetObserved) this.startEpoch(sample.cumulativeTokens);
    this.lastCumulativeTokens = sample.cumulativeTokens;

    return this.observation(
      Math.max(0, sample.cumulativeTokens - this.cumulativeBaseline),
      sample.contextWindow,
      counterResetObserved,
    );
  }

  recordCompactionObserved(cumulativeTokens: number): void {
    const baseline = Number.isFinite(cumulativeTokens) && cumulativeTokens >= 0
      ? cumulativeTokens
      : this.lastCumulativeTokens ?? 0;
    this.startEpoch(baseline);
  }

  private startEpoch(cumulativeTokens: number): void {
    this.cumulativeBaseline = cumulativeTokens;
    this.lastCumulativeTokens = cumulativeTokens;
  }

  private observation(
    spendSinceCompaction: number,
    contextWindow: number,
    counterResetObserved: boolean,
  ): CodexTurnCostObservation {
    return {
      spendSinceCompaction,
      contextWindow,
      multiple: contextWindow > 0 ? spendSinceCompaction / contextWindow : 0,
      counterResetObserved,
    };
  }
}
