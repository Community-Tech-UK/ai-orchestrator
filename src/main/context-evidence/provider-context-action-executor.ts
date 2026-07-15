export type ProviderContextExecutableAction =
  | 'rebuild-working-set'
  | 'native-compaction'
  | 'controlled-interrupt'
  | 'controlled-recovery'
  | 'same-thread-continuation';

export type ProviderContextActionProof = 'none' | 'requested' | 'acknowledged' | 'observed';

export interface ProviderContextActionHandlerResult {
  proof: ProviderContextActionProof;
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
