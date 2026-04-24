import { getLogger } from '../../logging/logger';
import type { AdapterRuntimeCapabilities, ResumeAttemptResult } from '../../cli/adapters/base-cli-adapter';
import type { ResumeCursor } from '../../session/session-continuity';

const logger = getLogger('SessionRecovery');

export type RecoveryReason =
  | 'wake'
  | 'restart'
  | 'interrupt'
  | 'unexpected-exit'
  | 'deferred-permission'
  | 'history-restore'
  | 'prompt-edit';

export type RecoveryPlanKind =
  | 'native-resume'
  | 'provider-fork'
  | 'replay-fallback'
  | 'fresh'
  | 'failed';

export interface RecoveryPlanInput {
  instanceId: string;
  reason: RecoveryReason;
  previousAdapterId?: string;
  previousProviderSessionId?: string;
  provider: string;
  model?: string;
  agent?: string;
  cwd: string;
  yolo?: boolean;
  executionLocation?: string;
  resumeCursor?: ResumeCursor | null;
  resumeCursorSource?: string;
  capabilities: Pick<AdapterRuntimeCapabilities, 'supportsResume' | 'supportsForkSession'>;
  pendingUserInput?: unknown;
  continuitySnapshot?: unknown;
  outputBufferSnapshot?: unknown;
  activeTurnId?: string;
  adapterGeneration: number;
  hasConversation?: boolean;
  sessionResumeBlacklisted?: boolean;
  allowFreshWithoutConversation?: boolean;
  replayUnsafeReason?: string;
}

export type RecoveryPlan =
  | {
      kind: 'native-resume';
      expectedProof: 'provider-session-match' | 'resume-cursor-match';
      confidence: 'high' | 'medium' | 'low';
      requestedSessionId?: string;
      requestedCursor?: ResumeCursor | null;
    }
  | {
      kind: 'provider-fork';
      expectedProof: 'provider-session-match' | 'resume-cursor-match';
      confidence: 'high' | 'medium' | 'low';
      requestedSessionId?: string;
      requestedCursor?: ResumeCursor | null;
    }
  | {
      kind: 'replay-fallback';
      packetId: string;
      confidence: 'medium' | 'low';
      reason: string;
    }
  | {
      kind: 'fresh';
      reason: string;
      confidence: 'low';
    }
  | {
      kind: 'failed';
      reason: string;
      retryable: boolean;
    };

export interface RecoveryResult {
  success: boolean;
  error?: string;
  method?: 'native-resume' | 'replay-fallback';
  plan?: RecoveryPlan;
  proof?: ResumeAttemptResult;
}

export interface RecoveryDeps {
  nativeResume: (instanceId: string, sessionId: string) => Promise<RecoveryResult>;
  replayFallback: (instanceId: string, sessionId: string) => Promise<RecoveryResult>;
}

export function planSessionRecovery(input: RecoveryPlanInput): RecoveryPlan {
  if (input.replayUnsafeReason) {
    return {
      kind: 'failed',
      reason: input.replayUnsafeReason,
      retryable: false,
    };
  }

  const requestedSessionId = input.previousProviderSessionId ?? input.resumeCursor?.threadId;
  if (
    input.capabilities.supportsResume
    && requestedSessionId
    && !input.sessionResumeBlacklisted
  ) {
    return {
      kind: input.capabilities.supportsForkSession ? 'provider-fork' : 'native-resume',
      expectedProof: input.resumeCursor ? 'resume-cursor-match' : 'provider-session-match',
      confidence: input.resumeCursor ? 'high' : 'medium',
      requestedSessionId,
      requestedCursor: input.resumeCursor ?? null,
    };
  }

  if (input.hasConversation) {
    return {
      kind: 'replay-fallback',
      packetId: `${input.instanceId}:${input.reason}:${input.adapterGeneration}`,
      confidence: input.sessionResumeBlacklisted ? 'medium' : 'low',
      reason: input.sessionResumeBlacklisted
        ? 'provider session id is blacklisted'
        : 'native resume is unavailable or missing a provider session id',
    };
  }

  if (input.allowFreshWithoutConversation !== false) {
    return {
      kind: 'fresh',
      reason: 'no conversation snapshot available to replay',
      confidence: 'low',
    };
  }

  return {
    kind: 'failed',
    reason: 'no native resume proof and replay is unavailable',
    retryable: true,
  };
}

export class SessionRecoveryCoordinator {
  private deps: RecoveryDeps;

  constructor(deps: RecoveryDeps) {
    this.deps = deps;
  }

  plan(input: RecoveryPlanInput): RecoveryPlan {
    return planSessionRecovery(input);
  }

  prove(plan: RecoveryPlan, proof: ResumeAttemptResult | undefined): RecoveryResult {
    if (!proof || proof.source === 'none') {
      return {
        success: false,
        error: 'No resume proof was produced by the adapter',
        plan,
        proof,
      };
    }

    if ((plan.kind === 'native-resume' || plan.kind === 'provider-fork') && !proof.confirmed) {
      return {
        success: false,
        error: proof.reason ?? 'Native resume was not confirmed',
        plan,
        proof,
      };
    }

    return {
      success: true,
      method: plan.kind === 'replay-fallback' ? 'replay-fallback' : 'native-resume',
      plan,
      proof,
    };
  }

  async recover(
    instanceId: string,
    sessionId: string,
    input?: Omit<RecoveryPlanInput, 'instanceId' | 'previousProviderSessionId'>,
  ): Promise<RecoveryResult> {
    const plan = input
      ? this.plan({
          ...input,
          instanceId,
          previousProviderSessionId: sessionId,
        })
      : undefined;

    logger.info('Attempting session recovery', {
      instanceId,
      sessionId,
      reason: input?.reason,
      planKind: plan?.kind,
    });

    if (plan?.kind === 'failed') {
      return { success: false, error: plan.reason, plan };
    }

    if (plan?.kind === 'fresh') {
      return { success: false, error: plan.reason, plan };
    }

    // Phase 1: Try native resume
    if (!plan || plan.kind === 'native-resume' || plan.kind === 'provider-fork') {
      const nativeResult = await this.deps.nativeResume(instanceId, sessionId);
      if (nativeResult.success) {
        logger.info('Native resume succeeded', { instanceId, sessionId });
        return { ...nativeResult, method: 'native-resume', plan: nativeResult.plan ?? plan };
      }

      logger.info('Native resume failed, trying replay', {
        instanceId,
        error: nativeResult.error ?? 'unknown',
      });
    }

    // Phase 2: Fall back to replay
    const replayResult = await this.deps.replayFallback(instanceId, sessionId);
    if (replayResult.success) {
      logger.info('Replay fallback succeeded', { instanceId });
      return { ...replayResult, method: 'replay-fallback', plan: replayResult.plan ?? plan };
    }

    logger.warn('Recovery methods failed', { instanceId });
    return { success: false, error: replayResult.error ?? 'Both recovery methods failed', plan };
  }
}

/**
 * Backward-compatible export retained for existing callers/tests. New recovery
 * paths should depend on SessionRecoveryCoordinator.
 */
export class SessionRecoveryHandler extends SessionRecoveryCoordinator {}
