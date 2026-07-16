import { EvidenceCardSchema } from '@contracts/schemas/context-evidence';
import type { EvidenceCard, EvidenceCitation } from '@contracts/types/context-evidence';
import type { EvidenceLedgerRecord } from '../../conversation-ledger/context-evidence-ledger.types';

export interface CardCitationDigestVerifier {
  verifyCitationDigest(
    content: Uint8Array,
    expectedDigest: string,
    keyVersion?: number,
  ): Promise<boolean>;
}

export type CardCitationValidationResult =
  | { valid: true }
  | {
      valid: false;
      code:
        | 'CARD_SCHEMA_INVALID'
        | 'CARD_EVIDENCE_MISMATCH'
        | 'EVIDENCE_NOT_AUTHENTICATED'
        | 'EVIDENCE_CONTENT_SIZE_MISMATCH'
        | 'CITATION_EVIDENCE_MISMATCH'
        | 'CITATION_RANGE_INVALID'
        | 'CITATION_DIGEST_INVALID';
    };

/** Validates every derived claim against exact authenticated raw-evidence bytes. */
export class CardCitationValidator {
  constructor(private readonly digestVerifier: CardCitationDigestVerifier) {}

  async validate(
    card: EvidenceCard,
    record: EvidenceLedgerRecord,
    content: Uint8Array,
  ): Promise<CardCitationValidationResult> {
    if (!EvidenceCardSchema.safeParse(card).success) {
      return { valid: false, code: 'CARD_SCHEMA_INVALID' };
    }
    if (card.evidenceId !== record.id) {
      return { valid: false, code: 'CARD_EVIDENCE_MISMATCH' };
    }
    if (
      record.status !== 'complete'
      || record.keyVersion === null
      || record.keyedContentId === null
      || record.blobRef === null
    ) {
      return { valid: false, code: 'EVIDENCE_NOT_AUTHENTICATED' };
    }
    if (content.byteLength !== record.byteCount) {
      return { valid: false, code: 'EVIDENCE_CONTENT_SIZE_MISMATCH' };
    }
    for (const citation of card.citations) {
      const result = await this.validateCitation(citation, record, content);
      if (!result.valid) return result;
    }
    return { valid: true };
  }

  private async validateCitation(
    citation: EvidenceCitation,
    record: EvidenceLedgerRecord,
    content: Uint8Array,
  ): Promise<CardCitationValidationResult> {
    if (citation.evidenceId !== record.id) {
      return { valid: false, code: 'CITATION_EVIDENCE_MISMATCH' };
    }
    if (
      !Number.isSafeInteger(citation.startByte)
      || !Number.isSafeInteger(citation.endByte)
      || citation.startByte < 0
      || citation.endByte <= citation.startByte
      || citation.endByte > content.byteLength
    ) {
      return { valid: false, code: 'CITATION_RANGE_INVALID' };
    }
    const range = content.subarray(citation.startByte, citation.endByte);
    const validDigest = await this.digestVerifier.verifyCitationDigest(
      range,
      citation.contentDigest,
      record.keyVersion ?? undefined,
    );
    return validDigest
      ? { valid: true }
      : { valid: false, code: 'CITATION_DIGEST_INVALID' };
  }
}
