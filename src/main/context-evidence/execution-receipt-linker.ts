export type ExecutionReceiptSource = 'loop' | 'tool' | 'verification-ledger';

export interface LinkableExecutionReceipt {
  receiptId: string;
  source: ExecutionReceiptSource;
  conversationId: string;
  status: 'succeeded' | 'failed';
  executedAt: number;
}

export interface ExecutionReceiptEvidenceLink extends LinkableExecutionReceipt {
  evidenceIds: string[];
  recordedAt: number;
}

/** Sidecar linkage keeps current receipt provenance intact and adds evidence ownership. */
export class ExecutionReceiptLinker {
  private readonly links = new Map<string, ExecutionReceiptEvidenceLink>();

  link(
    receipt: LinkableExecutionReceipt,
    evidenceIds: string[],
    recordedAt: number,
  ): ExecutionReceiptEvidenceLink {
    validateReceipt(receipt, evidenceIds, recordedAt);
    const uniqueEvidenceIds = [...new Set(evidenceIds)].sort();
    const existing = this.links.get(receipt.receiptId);
    if (existing) {
      if (
        existing.source !== receipt.source
        || existing.conversationId !== receipt.conversationId
        || existing.status !== receipt.status
        || existing.executedAt !== receipt.executedAt
        || !sameStrings(existing.evidenceIds, uniqueEvidenceIds)
      ) {
        throw new Error('EXECUTION_RECEIPT_LINK_CONFLICT');
      }
      return existing;
    }
    const link: ExecutionReceiptEvidenceLink = {
      receiptId: receipt.receiptId,
      source: receipt.source,
      conversationId: receipt.conversationId,
      status: receipt.status,
      executedAt: receipt.executedAt,
      evidenceIds: uniqueEvidenceIds,
      recordedAt,
    };
    this.links.set(link.receiptId, link);
    return link;
  }

  hasCurrentSuccess(conversationId: string, maxAgeMs: number, now: number): boolean {
    if (!conversationId || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return false;
    for (const link of this.links.values()) {
      if (
        link.conversationId === conversationId
        && link.status === 'succeeded'
        && link.executedAt <= now
        && now - link.executedAt <= maxAgeMs
      ) {
        return true;
      }
    }
    return false;
  }
}

function validateReceipt(
  receipt: LinkableExecutionReceipt,
  evidenceIds: string[],
  recordedAt: number,
): void {
  if (
    !receipt.receiptId.trim()
    || !receipt.conversationId.trim()
    || evidenceIds.length === 0
    || evidenceIds.some((id) => !id.trim())
    || !Number.isFinite(receipt.executedAt)
    || !Number.isFinite(recordedAt)
  ) {
    throw new Error('EXECUTION_RECEIPT_LINK_INVALID');
  }
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
