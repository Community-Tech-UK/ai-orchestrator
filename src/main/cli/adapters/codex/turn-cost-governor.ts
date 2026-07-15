export type CodexTurnCostAction = 'continue' | 'warn' | 'recover' | 'recover-urgent';

export interface CodexTurnCostSample {
  cumulativeTokens: number;
  contextWindow: number;
}

export interface CodexTurnCostDecision {
  action: CodexTurnCostAction;
  spendSinceCompaction: number;
  contextWindow: number;
  multiple: number;
}

export interface CodexTurnCostThresholds {
  warningMultiple: number;
  recoveryMultiple: number;
  urgentMultiple: number;
}

const DEFAULT_THRESHOLDS: CodexTurnCostThresholds = {
  warningMultiple: 2,
  recoveryMultiple: 4,
  urgentMultiple: 8,
};

function positiveFinite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export class CodexTurnCostGovernor {
  private readonly thresholds: CodexTurnCostThresholds;
  private cumulativeBaseline = 0;
  private lastCumulativeTokens: number | null = null;
  private warned = false;
  private recoveryRequested = false;

  constructor(thresholds: Partial<CodexTurnCostThresholds> = {}) {
    const warningMultiple = positiveFinite(
      thresholds.warningMultiple,
      DEFAULT_THRESHOLDS.warningMultiple,
    );
    const recoveryMultiple = Math.max(
      warningMultiple,
      positiveFinite(thresholds.recoveryMultiple, DEFAULT_THRESHOLDS.recoveryMultiple),
    );
    const urgentMultiple = Math.max(
      recoveryMultiple,
      positiveFinite(thresholds.urgentMultiple, DEFAULT_THRESHOLDS.urgentMultiple),
    );
    this.thresholds = { warningMultiple, recoveryMultiple, urgentMultiple };
  }

  getThresholds(): CodexTurnCostThresholds {
    return { ...this.thresholds };
  }

  observe(sample: CodexTurnCostSample): CodexTurnCostDecision {
    if (
      !Number.isFinite(sample.cumulativeTokens)
      || sample.cumulativeTokens < 0
      || !Number.isFinite(sample.contextWindow)
      || sample.contextWindow <= 0
    ) {
      return this.decision('continue', 0, sample.contextWindow);
    }

    if (
      this.lastCumulativeTokens !== null
      && sample.cumulativeTokens < this.lastCumulativeTokens
    ) {
      this.startEpoch(sample.cumulativeTokens);
    }
    this.lastCumulativeTokens = sample.cumulativeTokens;

    const spendSinceCompaction = Math.max(0, sample.cumulativeTokens - this.cumulativeBaseline);
    const multiple = spendSinceCompaction / sample.contextWindow;

    if (!this.recoveryRequested && multiple >= this.thresholds.urgentMultiple) {
      this.warned = true;
      this.recoveryRequested = true;
      return this.decision('recover-urgent', spendSinceCompaction, sample.contextWindow);
    }

    if (!this.recoveryRequested && multiple >= this.thresholds.recoveryMultiple) {
      this.warned = true;
      this.recoveryRequested = true;
      return this.decision('recover', spendSinceCompaction, sample.contextWindow);
    }

    if (!this.warned && multiple >= this.thresholds.warningMultiple) {
      this.warned = true;
      return this.decision('warn', spendSinceCompaction, sample.contextWindow);
    }

    return this.decision('continue', spendSinceCompaction, sample.contextWindow);
  }

  recordCompactionObserved(cumulativeTokens: number): void {
    const baseline = Number.isFinite(cumulativeTokens) && cumulativeTokens >= 0
      ? cumulativeTokens
      : this.lastCumulativeTokens ?? 0;
    this.startEpoch(baseline);
  }

  recordRecoveryAttemptFailed(): void {
    this.recoveryRequested = false;
  }

  private startEpoch(cumulativeTokens: number): void {
    this.cumulativeBaseline = cumulativeTokens;
    this.lastCumulativeTokens = cumulativeTokens;
    this.warned = false;
    this.recoveryRequested = false;
  }

  private decision(
    action: CodexTurnCostAction,
    spendSinceCompaction: number,
    contextWindow: number,
  ): CodexTurnCostDecision {
    return {
      action,
      spendSinceCompaction,
      contextWindow,
      multiple: contextWindow > 0 ? spendSinceCompaction / contextWindow : 0,
    };
  }
}
