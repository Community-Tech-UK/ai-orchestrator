import { getLogger } from '../../logging/logger';

const logger = getLogger('SessionRecovery');

export interface RecoveryResult {
  success: boolean;
  error?: string;
  method?: 'native-resume' | 'replay-fallback';
}

export interface RecoveryDeps {
  nativeResume: (instanceId: string, sessionId: string) => Promise<RecoveryResult>;
  replayFallback: (instanceId: string, sessionId: string) => Promise<RecoveryResult>;
}

export class SessionRecoveryHandler {
  private deps: RecoveryDeps;

  constructor(deps: RecoveryDeps) {
    this.deps = deps;
  }

  async recover(instanceId: string, sessionId: string): Promise<RecoveryResult> {
    logger.info(`Attempting session recovery for ${instanceId}, session ${sessionId}`);

    // Phase 1: Try native resume
    const nativeResult = await this.deps.nativeResume(instanceId, sessionId);
    if (nativeResult.success) {
      logger.info(`Native resume succeeded for ${instanceId}`);
      return { ...nativeResult, method: 'native-resume' };
    }

    logger.info(`Native resume failed for ${instanceId}: ${nativeResult.error ?? 'unknown'}, trying replay`);

    // Phase 2: Fall back to replay
    const replayResult = await this.deps.replayFallback(instanceId, sessionId);
    if (replayResult.success) {
      logger.info(`Replay fallback succeeded for ${instanceId}`);
      return { ...replayResult, method: 'replay-fallback' };
    }

    logger.warn(`Both recovery methods failed for ${instanceId}`);
    return { success: false, error: replayResult.error ?? 'Both recovery methods failed' };
  }
}
