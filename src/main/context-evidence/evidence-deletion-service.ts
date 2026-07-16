import type {
  ConversationEvidenceDeletionInput,
  ConversationEvidenceDeletionResult,
  EvidenceDeletionQueueRecord,
} from '../conversation-ledger/context-evidence-ledger.types';
import { getLogger } from '../logging/logger';

export const EVIDENCE_DELETION_GRACE_MS = 10 * 60 * 1000;
const DEFAULT_CLAIM_LEASE_MS = 60_000;
const MAX_JANITOR_BATCH = 100;
const MAX_RETRY_BACKOFF_MS = 60 * 60 * 1000;
const DEFAULT_JANITOR_INTERVAL_MS = 60_000;
const DEFAULT_JANITOR_BATCH = 100;
const logger = getLogger('EvidenceDeletionService');

export interface EvidenceDeletionLedger {
  softDeleteConversationWithEvidence(
    input: ConversationEvidenceDeletionInput,
  ): Promise<ConversationEvidenceDeletionResult>;
  claimEvidenceDeletions(
    now: number,
    limit: number,
    leaseMs?: number,
  ): Promise<EvidenceDeletionQueueRecord[]>;
  completeEvidenceDeletion(id: string, claimToken: string, completedAt: number): Promise<boolean>;
  failEvidenceDeletion(
    id: string,
    claimToken: string,
    errorCode: string,
    retryAt: number,
  ): Promise<boolean>;
}

export interface EvidenceDeletionBlobStore {
  remove(blobRef: string): Promise<void>;
}

export interface EvidenceDeletionServiceOptions {
  ledger: EvidenceDeletionLedger;
  blobStore: EvidenceDeletionBlobStore;
  now?: () => number;
}

/** Revokes evidence transactionally, then removes only leased opaque refs in bounded batches. */
export class EvidenceDeletionService {
  private readonly now: () => number;
  private janitorTimer: ReturnType<typeof setInterval> | null = null;
  private janitorRunning = false;

  constructor(private readonly options: EvidenceDeletionServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async revokeConversation(conversationId: string): Promise<ConversationEvidenceDeletionResult> {
    if (!conversationId.trim()) throw new Error('CONVERSATION_OWNERSHIP_REQUIRED');
    const now = this.now();
    return this.options.ledger.softDeleteConversationWithEvidence({
      conversationId,
      deletedAt: new Date(now).toISOString(),
      graceDeadline: now + EVIDENCE_DELETION_GRACE_MS,
    });
  }

  async runJanitor(limit = 25): Promise<{ claimed: number; deleted: number; failed: number }> {
    const now = this.now();
    const boundedLimit = Math.max(1, Math.min(limit, MAX_JANITOR_BATCH));
    const claims = await this.options.ledger.claimEvidenceDeletions(
      now,
      boundedLimit,
      DEFAULT_CLAIM_LEASE_MS,
    );
    let deleted = 0;
    let failed = 0;
    for (const claim of claims) {
      if (!claim.claimToken) {
        failed += 1;
        continue;
      }
      try {
        await this.options.blobStore.remove(claim.blobRef);
        if (await this.options.ledger.completeEvidenceDeletion(claim.id, claim.claimToken, now)) {
          deleted += 1;
        } else {
          failed += 1;
        }
      } catch (error) {
        if (isAlreadyAbsent(error)) {
          if (await this.options.ledger.completeEvidenceDeletion(claim.id, claim.claimToken, now)) {
            deleted += 1;
          } else {
            failed += 1;
          }
          continue;
        }
        const retryAt = now + retryBackoffMs(claim.attempts);
        await this.options.ledger.failEvidenceDeletion(
          claim.id,
          claim.claimToken,
          contentFreeErrorCode(error),
          retryAt,
        );
        failed += 1;
      }
    }
    return { claimed: claims.length, deleted, failed };
  }

  startJanitorScheduler(intervalMs = DEFAULT_JANITOR_INTERVAL_MS): void {
    if (this.janitorTimer) return;
    const boundedIntervalMs = Math.max(1_000, intervalMs);
    this.janitorTimer = setInterval(() => {
      if (this.janitorRunning) return;
      this.janitorRunning = true;
      void this.runJanitor(DEFAULT_JANITOR_BATCH)
        .catch((error: unknown) => {
          logger.warn('Evidence deletion sweep failed', {
            errorCode: contentFreeErrorCode(error),
          });
        })
        .finally(() => {
          this.janitorRunning = false;
        });
    }, boundedIntervalMs);
    this.janitorTimer.unref?.();
  }

  stopJanitorScheduler(): void {
    if (!this.janitorTimer) return;
    clearInterval(this.janitorTimer);
    this.janitorTimer = null;
  }
}

function retryBackoffMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts, 20));
  return Math.min(2 ** exponent * 1000, MAX_RETRY_BACKOFF_MS);
}

function contentFreeErrorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : 'EVIDENCE_DELETE_FAILED';
}

function isAlreadyAbsent(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'BLOB_NOT_FOUND';
}
