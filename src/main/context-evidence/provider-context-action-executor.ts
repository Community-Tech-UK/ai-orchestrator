export type ProviderContextExecutableAction =
  | 'rebuild-working-set'
  | 'native-compaction'
  | 'steer-turn'
  | 'controlled-interrupt'
  | 'controlled-recovery'
  | 'same-thread-continuation';

export type ProviderContextActionProof = 'none' | 'requested' | 'acknowledged' | 'observed';

export interface ProviderContextActionHandlerResult {
  proof: ProviderContextActionProof;
  /**
   * The action no longer applied by the time it ran, e.g. a steer that lost
   * the race with the turn finishing. This is not a failed action, so it must
   * not feed the compaction circuit breaker.
   */
  skipped?: 'turn-not-active';
}

export type ProviderContextActionHandler = () => Promise<ProviderContextActionHandlerResult>;

export type ProviderContextActionHandlers = Partial<
  Record<ProviderContextExecutableAction, ProviderContextActionHandler>
>;

export type ProviderContextActionExecutionResult =
  | {
      status: 'executed';
      action: ProviderContextExecutableAction;
      proof: ProviderContextActionProof;
    }
  | {
      status: 'skipped';
      action: ProviderContextExecutableAction;
      proof: 'none';
      errorCode: 'TURN_NOT_ACTIVE';
    }
  | {
      status: 'unavailable' | 'failed';
      action: ProviderContextExecutableAction;
      proof: 'none';
      errorCode: 'ACTION_UNAVAILABLE' | 'ACTION_FAILED';
    };

/** Keeps provider commands and their proof stages outside the pure policy. */
export class ProviderContextActionExecutor {
  constructor(private readonly handlers: ProviderContextActionHandlers) {}

  async execute(
    action: ProviderContextExecutableAction,
  ): Promise<ProviderContextActionExecutionResult> {
    const handler = this.handlers[action];
    if (!handler) {
      return {
        status: 'unavailable',
        action,
        proof: 'none',
        errorCode: 'ACTION_UNAVAILABLE',
      };
    }
    try {
      const result = await handler();
      if (result.skipped) {
        return { status: 'skipped', action, proof: 'none', errorCode: 'TURN_NOT_ACTIVE' };
      }
      return { status: 'executed', action, proof: result.proof };
    } catch {
      return {
        status: 'failed',
        action,
        proof: 'none',
        errorCode: 'ACTION_FAILED',
      };
    }
  }
}
