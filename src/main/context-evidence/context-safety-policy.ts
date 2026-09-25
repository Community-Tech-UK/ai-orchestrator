import type {
  ContextPressureSample,
  EnforcementAction,
  EnforcementTrigger,
  EvidenceCaptureMode,
  ProviderContextCapabilities,
} from '@contracts/types/context-evidence';

const OCCUPANCY_TRIGGERS: {
  ratio: number;
  trigger: Extract<
    EnforcementTrigger,
    | 'known-occupancy-60'
    | 'known-occupancy-70'
    | 'known-occupancy-75'
    | 'known-occupancy-80'
  >;
}[] = [
  { ratio: 0.80, trigger: 'known-occupancy-80' },
  { ratio: 0.75, trigger: 'known-occupancy-75' },
  { ratio: 0.70, trigger: 'known-occupancy-70' },
  { ratio: 0.6, trigger: 'known-occupancy-60' },
];

const MAX_RECOVERIES = 3;

/** When cumulative spend alone may trigger the 4x controlled recovery. */
export interface CumulativeRecoveryLimits {
  /**
   * Below this known occupancy, spend alone does not justify a recovery.
   * Every model request resends the whole cached context, so an ordinary
   * 20-tool-call turn at 50k tokens crosses 4x a 258k window. Compacting a
   * context that small interrupts the task and pays for a slow compaction
   * call while barely shrinking what later requests resend.
   */
  minOccupancyPercent: number;
  /**
   * Spend since the epoch, in context windows, that forces the recovery at
   * any occupancy. Without it a turn that stays under the floor would have
   * no spend ceiling at all. At 16x and 25% occupancy this is ~64 requests.
   */
  backstopMultiple: number;
}

/** Mirrored by the `contextSpendRecovery*` settings defaults. */
export const DEFAULT_CUMULATIVE_RECOVERY_LIMITS: Readonly<CumulativeRecoveryLimits> = {
  minOccupancyPercent: 50,
  backstopMultiple: 16,
};

export interface ContextSafetyPolicyState {
  outerSendId: string;
  epoch: number;
  cumulativeBaselineTokens: number;
  recoveriesInEpoch: number;
  recoveriesInOuterSend: number;
  emittedTriggers: EnforcementTrigger[];
}

export interface ContextSafetyPolicyInput {
  sample: ContextPressureSample;
  capabilities: ProviderContextCapabilities;
  state: ContextSafetyPolicyState;
  now: number;
  effectiveWindowTokens?: number;
  /** Defaults to {@link DEFAULT_CUMULATIVE_RECOVERY_LIMITS}. */
  cumulativeRecoveryLimits?: CumulativeRecoveryLimits;
  oversizedResult?: boolean;
  atSafeProviderBoundary?: boolean;
  consecutiveNoProgressRequests?: number;
  duplicateInterruptedTurnReplay?: boolean;
  providerDisconnected?: boolean;
  continuationProofObserved?: boolean;
}

export interface ContextSafetyPolicyDecision {
  action: EnforcementAction;
  nextState: ContextSafetyPolicyState;
  reasonCode: string;
  occupancyPercent?: number;
  captureDisposition?: Extract<EvidenceCaptureMode, 'pre-retention' | 'post-retention'>;
  deferredUntilSafeBoundary?: boolean;
  requiredSequence?: [
    'controlled-interrupt',
    'observed-compaction',
    'same-thread-continuation',
  ];
}

export interface ContextSafetyPolicyOptions {
  unknownOutputByteBudget?: number;
  unknownRequestBudget?: number;
  noProgressRequestThreshold?: number;
}

export type ContextEpochProofEvent =
  | 'compaction-requested'
  | 'compaction-acknowledged'
  | 'compaction-observed'
  | 'provider-counter-reset-observed';

export function createInitialContextSafetyPolicyState(
  outerSendId: string,
): ContextSafetyPolicyState {
  return {
    outerSendId,
    epoch: 0,
    cumulativeBaselineTokens: 0,
    recoveriesInEpoch: 0,
    recoveriesInOuterSend: 0,
    emittedTriggers: [],
  };
}

/** Pure provider-neutral pressure policy; execution/proof observation lives elsewhere. */
export class ContextSafetyPolicy {
  private readonly unknownOutputByteBudget: number;
  private readonly unknownRequestBudget: number;
  private readonly noProgressRequestThreshold: number;

  constructor(options: ContextSafetyPolicyOptions = {}) {
    this.unknownOutputByteBudget = options.unknownOutputByteBudget ?? 1_048_576;
    this.unknownRequestBudget = options.unknownRequestBudget ?? 20;
    this.noProgressRequestThreshold = options.noProgressRequestThreshold ?? 3;
  }

  decide(input: ContextSafetyPolicyInput): ContextSafetyPolicyDecision {
    if (input.duplicateInterruptedTurnReplay) {
      return this.pause(input, 'manual', 'DUPLICATE_REPLAY_PROHIBITED');
    }
    if (input.providerDisconnected) {
      if (
        input.continuationProofObserved
        && input.capabilities.sameThreadContinuation
      ) {
        return this.decision(input, 'same-thread-continuation', 'manual', 'CONTINUATION_PROVEN');
      }
      return this.pause(input, 'manual', 'PROVIDER_CONTINUATION_PROOF_REQUIRED');
    }
    if (input.oversizedResult) return this.decideOversizedResult(input);

    const occupancyPercent = input.capabilities.occupancyReporting === 'current'
      ? knownOccupancyPercent(input.sample)
      : undefined;
    if (occupancyPercent === undefined && this.unknownBudgetReached(input.sample)) {
      return this.pause(
        input,
        'unknown-occupancy-budget',
        'UNKNOWN_OCCUPANCY_BUDGET_REACHED',
      );
    }

    if (occupancyPercent !== undefined) {
      const occupancyDecision = this.decideKnownOccupancy(input, occupancyPercent);
      if (occupancyDecision) return occupancyDecision;
    }

    const cumulativeDecision = this.decideCumulative(input, occupancyPercent);
    if (cumulativeDecision) return cumulativeDecision;

    if (
      (input.consecutiveNoProgressRequests ?? 0) >= this.noProgressRequestThreshold
      && input.sample.newEvidenceCount === 0
      && input.sample.newValidatedFindingCount === 0
      && !input.state.emittedTriggers.includes('no-evidence-progress')
    ) {
      return this.decision(
        input,
        'convergence-review',
        'no-evidence-progress',
        'EVIDENCE_PROGRESS_STALLED',
        this.withEmitted(input.state, ['no-evidence-progress']),
      );
    }

    return this.decision(input, 'none', 'manual', 'NO_ACTION', input.state, occupancyPercent);
  }

  advanceEpoch(
    state: ContextSafetyPolicyState,
    event: ContextEpochProofEvent,
    cumulativeTokens = 0,
  ): ContextSafetyPolicyState {
    if (event !== 'compaction-observed' && event !== 'provider-counter-reset-observed') {
      return state;
    }
    return {
      ...state,
      epoch: state.epoch + 1,
      cumulativeBaselineTokens: Math.max(0, Math.floor(cumulativeTokens)),
      recoveriesInEpoch: 0,
      emittedTriggers: [],
    };
  }

  private decideOversizedResult(
    input: ContextSafetyPolicyInput,
  ): ContextSafetyPolicyDecision {
    if (input.capabilities.toolResultControl === 'none') {
      return this.pause(input, 'oversized-result', 'RESULT_CONTROL_UNAVAILABLE');
    }
    if (input.capabilities.toolResultControl === 'pre-retention') {
      return {
        ...this.decision(input, 'externalize-result', 'oversized-result', 'RESULT_EXTERNALIZED'),
        captureDisposition: 'pre-retention',
      };
    }
    if (!input.atSafeProviderBoundary) {
      return {
        ...this.decision(input, 'none', 'oversized-result', 'POST_RETENTION_PRESSURE_DEFERRED'),
        captureDisposition: 'post-retention',
        deferredUntilSafeBoundary: true,
      };
    }
    if (canUseObservedNativeCompaction(input.capabilities)) {
      return {
        ...this.decision(input, 'native-compaction', 'oversized-result', 'POST_RETENTION_COMPACTION_REQUIRED'),
        captureDisposition: 'post-retention',
      };
    }
    return {
      ...this.pause(input, 'oversized-result', 'POST_RETENTION_PRESSURE_UNSAFE'),
      captureDisposition: 'post-retention',
    };
  }

  private decideKnownOccupancy(
    input: ContextSafetyPolicyInput,
    occupancyPercent: number,
  ): ContextSafetyPolicyDecision | null {
    const crossed = OCCUPANCY_TRIGGERS.find(({ ratio, trigger }) =>
      occupancyPercent >= ratio * 100 && !input.state.emittedTriggers.includes(trigger));
    if (!crossed) return null;
    const crossedAndLower = OCCUPANCY_TRIGGERS
      .filter(({ ratio }) => occupancyPercent >= ratio * 100)
      .map(({ trigger }) => trigger);
    const nextState = this.withEmitted(input.state, crossedAndLower);

    switch (crossed.trigger) {
      case 'known-occupancy-80':
        // At an idle boundary there is no turn to interrupt. Choosing the
        // interrupt path here made the provider answer "no active turn", the
        // recovery paused, and the thread was never compacted.
        if (input.atSafeProviderBoundary) {
          return canUseObservedNativeCompaction(input.capabilities)
            ? this.decision(
                input,
                'native-compaction',
                crossed.trigger,
                'IDLE_NATIVE_COMPACTION_REQUIRED',
                nextState,
                occupancyPercent,
              )
            : this.pause(
                input,
                crossed.trigger,
                'OBSERVED_COMPACTION_UNAVAILABLE',
                nextState,
                occupancyPercent,
              );
        }
        // Each recovery compacts, which advances the epoch and clears the
        // emitted triggers. Without this ceiling, one user send could loop
        // interrupt -> compact -> continue for as long as the model kept
        // refilling the window.
        if (recoveryCeilingReached(input.state)) {
          return this.pause(
            input,
            crossed.trigger,
            'RECOVERY_CEILING_REACHED',
            nextState,
            occupancyPercent,
          );
        }
        if (canRunControlledContinuation(input.capabilities)) {
          return {
            ...this.decision(
              input,
              'controlled-interrupt',
              crossed.trigger,
              'CONTROLLED_CONTINUATION_REQUIRED',
              withRecoveryCounted(nextState),
              occupancyPercent,
            ),
            requiredSequence: [
              'controlled-interrupt',
              'observed-compaction',
              'same-thread-continuation',
            ],
          };
        }
        return this.pause(
          input,
          crossed.trigger,
          'CONTROLLED_CONTINUATION_UNAVAILABLE',
          nextState,
          occupancyPercent,
        );
      case 'known-occupancy-75':
        if (!input.atSafeProviderBoundary) {
          // Keep occupancy-75 unemitted so compact can still fire once idle.
          if (input.state.emittedTriggers.includes('known-occupancy-70')) {
            return this.decision(input, 'none', crossed.trigger, 'NO_ACTION', input.state);
          }
          return this.decision(
            input,
            'steer-turn',
            'known-occupancy-70',
            'MID_TURN_STEER_REQUIRED',
            this.withEmitted(input.state, ['known-occupancy-60', 'known-occupancy-70']),
            occupancyPercent,
          );
        }
        return canUseObservedNativeCompaction(input.capabilities)
          ? this.decision(
              input,
              'native-compaction',
              crossed.trigger,
              'OBSERVED_NATIVE_COMPACTION_REQUIRED',
              nextState,
              occupancyPercent,
            )
          : this.pause(
              input,
              crossed.trigger,
              'OBSERVED_COMPACTION_UNAVAILABLE',
              nextState,
              occupancyPercent,
            );
      case 'known-occupancy-70':
        return this.decision(
          input,
          'steer-turn',
          crossed.trigger,
          'TURN_STEER_REQUIRED',
          nextState,
          occupancyPercent,
        );
      case 'known-occupancy-60':
        return input.capabilities.transcriptControl === 'rebuild'
          ? this.decision(
              input,
              'rebuild-working-set',
              crossed.trigger,
              'WORKING_SET_REBUILD_REQUIRED',
              nextState,
              occupancyPercent,
            )
          : this.pause(
              input,
              crossed.trigger,
              'WORKING_SET_REBUILD_UNAVAILABLE',
              nextState,
              occupancyPercent,
            );
    }
  }

  private decideCumulative(
    input: ContextSafetyPolicyInput,
    occupancyPercent: number | undefined,
  ): ContextSafetyPolicyDecision | null {
    if (input.capabilities.cumulativeReporting !== 'available') return null;
    const window = input.effectiveWindowTokens
      ?? (input.sample.occupancy.status === 'known' ? input.sample.occupancy.total : undefined);
    const cumulative = input.sample.cumulativeTokens;
    if (!window || cumulative === undefined || window <= 0) return null;
    const sinceEpoch = Math.max(0, cumulative - input.state.cumulativeBaselineTokens);
    // Unknown occupancy keeps the recovery: spend is then the only signal.
    // A known small context leaves 4x unemitted, so it still fires this epoch
    // once occupancy reaches the floor or spend reaches the backstop.
    const limits = input.cumulativeRecoveryLimits ?? DEFAULT_CUMULATIVE_RECOVERY_LIMITS;
    const contextWorthCompacting = occupancyPercent === undefined
      || occupancyPercent >= limits.minOccupancyPercent
      || sinceEpoch >= window * limits.backstopMultiple;

    if (
      sinceEpoch >= window * 4
      && contextWorthCompacting
      && !input.state.emittedTriggers.includes('cumulative-4x')
    ) {
      const nextState = this.withEmitted(input.state, ['cumulative-2x', 'cumulative-4x']);
      if (recoveryCeilingReached(input.state)) {
        return this.pause(
          input,
          'cumulative-4x',
          'RECOVERY_CEILING_REACHED',
          nextState,
        );
      }
      if (!canRunControlledContinuation(input.capabilities)) {
        return this.pause(
          input,
          'cumulative-4x',
          'CONTROLLED_RECOVERY_UNAVAILABLE',
          nextState,
        );
      }
      return this.decision(
        input,
        'controlled-recovery',
        'cumulative-4x',
        'CUMULATIVE_RECOVERY_REQUIRED',
        withRecoveryCounted(nextState),
      );
    }

    if (
      sinceEpoch >= window * 2
      && !input.state.emittedTriggers.includes('cumulative-2x')
    ) {
      return this.decision(
        input,
        'convergence-review',
        'cumulative-2x',
        'CUMULATIVE_CHECKPOINT_REQUIRED',
        this.withEmitted(input.state, ['cumulative-2x']),
      );
    }
    return null;
  }

  private unknownBudgetReached(sample: ContextPressureSample): boolean {
    return (typeof sample.outputBytesSinceCompaction === 'number'
      && sample.outputBytesSinceCompaction >= this.unknownOutputByteBudget)
      || sample.providerRequestCount >= this.unknownRequestBudget;
  }

  private pause(
    input: ContextSafetyPolicyInput,
    trigger: EnforcementTrigger,
    reasonCode: string,
    nextState: ContextSafetyPolicyState = input.state,
    occupancyPercent?: number,
  ): ContextSafetyPolicyDecision {
    return this.decision(
      input,
      'pause',
      trigger,
      reasonCode,
      nextState,
      occupancyPercent,
    );
  }

  private decision(
    input: ContextSafetyPolicyInput,
    kind: EnforcementAction['kind'],
    trigger: EnforcementTrigger,
    reasonCode: string,
    nextState: ContextSafetyPolicyState = input.state,
    occupancyPercent?: number,
  ): ContextSafetyPolicyDecision {
    return {
      action: {
        kind,
        trigger,
        recoveryEpoch: input.state.epoch,
        proofRequired: proofForAction(kind),
        createdAt: input.now,
      },
      nextState,
      reasonCode,
      ...(occupancyPercent === undefined ? {} : { occupancyPercent }),
    };
  }

  private withEmitted(
    state: ContextSafetyPolicyState,
    triggers: EnforcementTrigger[],
  ): ContextSafetyPolicyState {
    return {
      ...state,
      emittedTriggers: [...new Set([...state.emittedTriggers, ...triggers])],
    };
  }
}

function knownOccupancyPercent(sample: ContextPressureSample): number | undefined {
  if (sample.occupancy.status !== 'known' || sample.occupancy.total <= 0) return undefined;
  return (sample.occupancy.used / sample.occupancy.total) * 100;
}

/** Shared by the 80% and cumulative-4x recoveries: both interrupt, compact and continue. */
function recoveryCeilingReached(state: ContextSafetyPolicyState): boolean {
  return state.recoveriesInEpoch >= MAX_RECOVERIES
    || state.recoveriesInOuterSend >= MAX_RECOVERIES;
}

function withRecoveryCounted(state: ContextSafetyPolicyState): ContextSafetyPolicyState {
  return {
    ...state,
    recoveriesInEpoch: state.recoveriesInEpoch + 1,
    recoveriesInOuterSend: state.recoveriesInOuterSend + 1,
  };
}

function canUseObservedNativeCompaction(capabilities: ProviderContextCapabilities): boolean {
  return capabilities.transcriptControl === 'native-compaction'
    && capabilities.compactionProof === 'observed';
}

function canRunControlledContinuation(capabilities: ProviderContextCapabilities): boolean {
  return capabilities.interruptProof === 'observed'
    && capabilities.compactionProof === 'observed'
    && capabilities.sameThreadContinuation;
}

function proofForAction(kind: EnforcementAction['kind']): EnforcementAction['proofRequired'] {
  switch (kind) {
    case 'native-compaction':
    case 'controlled-interrupt':
    case 'controlled-recovery':
    case 'same-thread-continuation':
      return 'observed';
    case 'steer-turn':
      return 'acknowledged';
    default:
      return 'none';
  }
}
