import type { EvidenceDeletionQueueRecord } from './context-evidence-ledger.types';

export interface EvidenceDeletionQueueRow {
  id: string;
  conversation_id: string;
  evidence_id: string | null;
  blob_ref: string;
  grace_deadline: number;
  attempts: number;
  claim_token: string | null;
  claimed_until: number | null;
  next_attempt_at: number;
  last_error_code: string | null;
  completed_at: number | null;
  created_at: number;
}

export function evidenceDeletionRowToRecord(
  row: EvidenceDeletionQueueRow,
): EvidenceDeletionQueueRecord {
  return {
    id: row.id, conversationId: row.conversation_id, evidenceId: row.evidence_id,
    blobRef: row.blob_ref, graceDeadline: row.grace_deadline, attempts: row.attempts,
    claimToken: row.claim_token, claimedUntil: row.claimed_until,
    nextAttemptAt: row.next_attempt_at, lastErrorCode: row.last_error_code,
    completedAt: row.completed_at, createdAt: row.created_at,
  };
}
