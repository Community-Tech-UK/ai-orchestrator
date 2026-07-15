import type { EvidenceLedgerRecord } from '../conversation-ledger/context-evidence-ledger.types';

export interface EvidencePreviewBlobStore {
  read(blobRef: string, expectedKeyedContentId?: string): Promise<Uint8Array>;
  deriveCitationDigest(content: Uint8Array, keyVersion?: number): Promise<string>;
}

export interface VerifiedEvidencePreview {
  evidenceId: string;
  preview: string;
  tokenCount: number;
  authenticatedComplete: true;
}

export interface EvidencePreviewOptions {
  headBytes?: number;
  tailBytes?: number;
}

export type EvidencePreviewResult =
  | {
      canReplaceOriginal: false;
      reasonCode: 'EVIDENCE_NOT_AUTHENTICATED' | 'EVIDENCE_CAPTURE_INCOMPLETE';
      disclosure?: string;
    }
  | { canReplaceOriginal: true; evidenceId: string; preview: VerifiedEvidencePreview };

const verifiedPreviews = new WeakSet<object>();

export function isVerifiedEvidencePreview(value: unknown): value is VerifiedEvidencePreview {
  return typeof value === 'object' && value !== null && verifiedPreviews.has(value);
}

/** Produces bounded provider prose only after complete authenticated blob persistence. */
export class EvidencePreviewBuilder {
  constructor(private readonly blobStore: EvidencePreviewBlobStore) {}

  async build(
    record: EvidenceLedgerRecord,
    options: EvidencePreviewOptions = {},
  ): Promise<EvidencePreviewResult> {
    if (!isAuthenticated(record)) {
      return { canReplaceOriginal: false, reasonCode: 'EVIDENCE_NOT_AUTHENTICATED' };
    }
    if (record.captureCompleteness !== 'complete') {
      return {
        canReplaceOriginal: false,
        reasonCode: 'EVIDENCE_CAPTURE_INCOMPLETE',
        disclosure: record.truncationReason
          ?? `Capture is ${record.captureCompleteness}; complete source coverage is unavailable.`,
      };
    }
    let content: Uint8Array;
    try {
      content = await this.blobStore.read(record.blobRef, record.keyedContentId);
    } catch {
      return { canReplaceOriginal: false, reasonCode: 'EVIDENCE_NOT_AUTHENTICATED' };
    }
    try {
      if (content.byteLength !== record.byteCount) {
        return { canReplaceOriginal: false, reasonCode: 'EVIDENCE_NOT_AUTHENTICATED' };
      }
      const headEnd = utf8SafeEnd(content, Math.min(options.headBytes ?? 512, content.byteLength));
      const rawTailStart = Math.max(headEnd, content.byteLength - (options.tailBytes ?? 512));
      const tailStart = utf8SafeStart(content, rawTailStart);
      const ranges = [{ start: 0, end: headEnd }];
      if (tailStart < content.byteLength && tailStart > headEnd) {
        ranges.push({ start: tailStart, end: content.byteLength });
      }
      const sections: string[] = [];
      for (const range of ranges) {
        const bytes = content.slice(range.start, range.end);
        const digest = await this.blobStore.deriveCitationDigest(bytes, record.keyVersion);
        sections.push(
          new TextDecoder().decode(bytes),
          `[evidence:${record.id}@${range.start}-${range.end}#${digest}]`,
        );
      }
      const text = [
        `[BEGIN UNTRUSTED EVIDENCE PREVIEW ${record.id}]`,
        ...sections,
        'The original authenticated evidence can be inspected through bounded retrieval.',
        `[END UNTRUSTED EVIDENCE PREVIEW ${record.id}]`,
      ].join('\n');
      const preview: VerifiedEvidencePreview = Object.freeze({
        evidenceId: record.id,
        preview: text,
        tokenCount: Math.max(1, Math.ceil(new TextEncoder().encode(text).byteLength / 4)),
        authenticatedComplete: true,
      });
      verifiedPreviews.add(preview);
      return { canReplaceOriginal: true, evidenceId: record.id, preview };
    } finally {
      content.fill(0);
    }
  }
}

function isAuthenticated(record: EvidenceLedgerRecord): record is EvidenceLedgerRecord & {
  blobRef: string;
  keyedContentId: string;
  keyVersion: number;
} {
  return record.status === 'complete'
    && record.blobRef !== null
    && record.keyedContentId !== null
    && record.keyVersion !== null;
}

function utf8SafeEnd(content: Uint8Array, candidate: number): number {
  let end = candidate;
  while (end > 0 && end < content.byteLength && isContinuationByte(content[end]!)) end -= 1;
  return end;
}

function utf8SafeStart(content: Uint8Array, candidate: number): number {
  let start = candidate;
  while (start < content.byteLength && isContinuationByte(content[start]!)) start += 1;
  return start;
}

function isContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}
