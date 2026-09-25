import { getLogger } from '../logging/logger';

const logger = getLogger('ProviderContextAction');

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
    context?: { instanceId?: string },
  ): Promise<ProviderContextActionExecutionResult> {
    const handler = this.handlers[action];
    if (!handler) {
      const result = {
        status: 'unavailable',
        action,
        proof: 'none',
        errorCode: 'ACTION_UNAVAILABLE',
      } as const;
      logger.info('Provider context action completed', { instanceId: context?.instanceId, ...result });
      return result;
    }
    try {
      const result = await handler();
      if (result.skipped) {
        const skipped = { status: 'skipped', action, proof: 'none', errorCode: 'TURN_NOT_ACTIVE' } as const;
        logger.info('Provider context action completed', { instanceId: context?.instanceId, ...skipped });
        return skipped;
      }
      const executed = { status: 'executed', action, proof: result.proof } as const;
      logger.info('Provider context action completed', { instanceId: context?.instanceId, ...executed });
      return executed;
    } catch (error) {
      const failed = {
        status: 'failed',
        action,
        proof: 'none',
        errorCode: 'ACTION_FAILED',
      } as const;
      logger.info('Provider context action completed', {
        instanceId: context?.instanceId,
        ...failed,
        error: error instanceof Error ? error.message : String(error),
      });
      return failed;
    }
  }
}
