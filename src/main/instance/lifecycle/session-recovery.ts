import { createHash } from 'node:crypto';
import { getLogger } from '../../logging/logger';
import type { AdapterRuntimeCapabilities, ResumeAttemptResult } from '../../cli/adapters/base-cli-adapter';
import type { ResumeCursor } from '../../session/session-continuity';

const logger = getLogger('SessionRecovery');

/**
 * Inputs to the provider/config fingerprint stamped onto a resume cursor (§6.2).
 * If the live config differs from what was captured with the cursor, native
 * resume is skipped — resuming a persisted session id against a *different*
 * model/MCP/cwd risks provider 400s or the wrong tools being available.
 *
 * Field selection (open question §10 Q5): provider + model + cwd are the
 * fields that actually change a session's validity in practice. `mcpFingerprint`
 * is optional so callers that can cheaply hash their MCP/auth config may include
 * it; absence simply means it is not part of the comparison.
 */
export interface ResumeConfigFingerprintParts {
  provider?: string;
  model?: string;
  cwd?: string;
  mcpFingerprint?: string;
  /**
   * GitHub Copilot account profile. A native Copilot session belongs to one
   * GitHub identity, so resuming it under another profile is a cross-account
   * leak — the fingerprint has to notice.
   *
   * Appended ONLY when non-empty. Adding a fifth segment unconditionally would
   * change the hash for every provider, so every persisted cursor in the wild
   * would mismatch once and native resume would be blocked app-wide on the
   * first launch after this shipped.
   */
  copilotProfileId?: string;
}

/**
 * Compute a short, stable fingerprint of the resume-affecting config. Hashed so
 * it stays compact and does not leak the raw cwd into logs/state dumps. Returns
 * `undefined` when there is nothing meaningful to fingerprint (so callers don't
 * store an empty-but-non-null marker that would always "match").
 */
export function computeResumeConfigFingerprint(
  parts: ResumeConfigFingerprintParts,
): string | undefined {
  const provider = parts.provider?.trim() ?? '';
  const model = parts.model?.trim() ?? '';
  const cwd = parts.cwd?.trim() ?? '';
  const mcp = parts.mcpFingerprint?.trim() ?? '';
  const copilotProfile = parts.copilotProfileId?.trim() ?? '';
  if (!provider && !model && !cwd && !mcp && !copilotProfile) return undefined;
  // NUL separators, not spaces: a value containing a space must not be
  // able to collide with a different split of the same fields.
  //
  // The base string is byte-identical to the pre-Copilot-routing version, so
  // a cursor persisted before this change still matches. Only a session that
  // actually carries a profile gets the extra segment.
  const base = `${provider}\x00${model}\x00${cwd}\x00${mcp}`;
  return createHash('sha256')
    .update(copilotProfile ? `${base}\x00${copilotProfile}` : base)
    .digest('hex')
    .slice(0, 16);
}

export type RecoveryReason =
  | 'wake'
  | 'restart'
  | 'interrupt'
  | 'unexpected-exit'
  | 'deferred-permission'
  | 'history-restore'
  | 'prompt-edit';

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
  /**
   * Set `false` when the provider session is brand-new and has not yet been
   * flushed to disk by the CLI (first turn still in flight). Native resume is
   * then skipped in favour of replay, because `--resume <sessionId>` would
   * fail with "No conversation found with session ID". `true`/`undefined`
   * leave resume eligible.
   */
  providerSessionPersisted?: boolean;
  allowFreshWithoutConversation?: boolean;
  replayUnsafeReason?: string;
  /**
   * Fingerprint of the *current* resume-affecting config (provider/model/cwd/…).
   * Compared against `resumeCursor.configFingerprint` (§6.2): if both are present
   * and differ, native resume is skipped in favour of replay because the
   * persisted session id was created under a different config.
   */
  currentConfigFingerprint?: string;
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
  // §6.2: a persisted cursor created under a different provider/model/cwd config
  // must not be natively resumed (risks provider 400s / wrong tools). Only block
  // when BOTH fingerprints are present and differ; missing data leaves resume
  // eligible (backwards-compatible with cursors captured before this field).
  const cursorFingerprint = input.resumeCursor?.configFingerprint;
  const configFingerprintMismatch = Boolean(
    cursorFingerprint
    && input.currentConfigFingerprint
    && cursorFingerprint !== input.currentConfigFingerprint,
  );
  if (
    input.capabilities.supportsResume
    && requestedSessionId
    && !input.sessionResumeBlacklisted
    && !configFingerprintMismatch
    // Skip native resume while the session is known-unpersisted (fresh first
    // turn). Only an explicit `false` blocks; `undefined` keeps resume eligible.
    && input.providerSessionPersisted !== false
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
      confidence:
        input.sessionResumeBlacklisted
        || input.providerSessionPersisted === false
        || configFingerprintMismatch
          ? 'medium'
          : 'low',
      reason: input.sessionResumeBlacklisted
        ? 'provider session id is blacklisted'
        : configFingerprintMismatch
          ? 'resume config fingerprint changed since the session was created (model/cwd/MCP differ)'
          : input.providerSessionPersisted === false
            ? 'provider session not yet persisted (fresh first turn)'
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
        logger.info('Native resume succeeded', { instanceId });
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
