import type {
  EvidenceAccessLogInput,
  EvidenceCardMetadataRecord,
  EvidenceFailureInput,
  EvidenceLedgerRecord,
  EvidenceListQuery,
} from '../conversation-ledger/context-evidence-ledger.types';
import type {
  ContextEvidenceCardResponse,
  EvidenceCitation,
  EvidenceRetrievalResponse,
} from '@contracts/types/context-evidence';
import { timingSafeEqual } from 'node:crypto';
import type {
  EvidenceAccessPolicy,
  EvidenceAccessRequester,
} from './evidence-access-policy';
import {
  boundedEvidenceText,
  boundedUtf8Slice,
  calculateEvidenceRangeTokenBudget,
  EvidenceRetrievalError,
  isValidEvidenceRange,
  MAX_RANGE_BYTES_PER_TOKEN,
  trimIncompleteUtf8Suffix,
  validateEvidenceRange,
  wrapUntrustedEvidence,
} from './evidence-retrieval-limits';
import {
  asRecord,
  isEvidenceCitation,
  retrieveEvidenceCard,
} from './evidence-card-retrieval';
export {
  calculateEvidenceRangeTokenBudget,
  EvidenceRetrievalError,
} from './evidence-retrieval-limits';

const MAX_SEARCH_QUERY_BYTES = 200;
const MAX_SEARCH_RECORDS = 25;
export type EvidenceRequester = EvidenceAccessRequester;
export type EvidenceRetrievalPolicy = EvidenceAccessPolicy;

export interface EvidenceRetrievalLedger {
  getEvidence(conversationId: string, evidenceId: string): Promise<EvidenceLedgerRecord | null>;
  listEvidence(conversationId: string, query?: EvidenceListQuery): Promise<EvidenceLedgerRecord[]>;
  listEvidenceCards(
    conversationId: string,
    query?: { evidenceId?: string; limit?: number },
  ): Promise<EvidenceCardMetadataRecord[]>;
  getEvidenceCard(
    conversationId: string,
    cardId: string,
  ): Promise<EvidenceCardMetadataRecord | null>;
  logEvidenceAccess(input: EvidenceAccessLogInput): Promise<void>;
  failEvidence(input: EvidenceFailureInput): Promise<EvidenceLedgerRecord>;
}

export interface EvidenceRetrievalBlobStore {
  read(blobRef: string, expectedKeyedContentId?: string): Promise<Uint8Array>;
  readRange(
    blobRef: string,
    expectedKeyedContentId: string,
    startByte: number,
    endByte: number,
  ): Promise<Uint8Array>;
  find(
    blobRef: string,
    expectedKeyedContentId: string,
    needle: Uint8Array,
    maxResultBytes: number,
  ): Promise<{ startByte: number; bytes: Uint8Array } | null>;
  remove(blobRef: string): Promise<void>;
  deriveCitationDigest(content: Uint8Array, keyVersion?: number): Promise<string>;
  verifyCitationDigest(
    content: Uint8Array,
    expectedDigest: string,
    keyVersion?: number,
  ): Promise<boolean>;
}

export interface EvidenceRetrievalServiceOptions {
  ledger: EvidenceRetrievalLedger;
  blobStore: EvidenceRetrievalBlobStore;
  policy: EvidenceRetrievalPolicy;
  estimateTokens: (text: string) => number;
  now?: () => number;
}

export interface EvidenceReadInput {
  requester: EvidenceRequester;
  conversationId: string;
  evidenceId: string;
  startByte: number;
  endByte: number;
  tokenLimit: number;
  providerWindowTokens?: number;
}

export interface EvidenceSearchInput {
  requester: EvidenceRequester;
  conversationId: string;
  query: string;
  tokenLimit: number;
  providerWindowTokens?: number;
}

export interface EvidenceListInput {
  requester: EvidenceRequester;
  conversationId: string;
  limit?: number;
}

export interface EvidenceGetCardInput extends Pick<EvidenceReadInput,
  'requester' | 'conversationId' | 'tokenLimit' | 'providerWindowTokens'> {
  cardId: string;
}

export interface EvidenceSearchMatch {
  matchKind: 'card' | 'raw';
  evidenceId: string;
  startByte: number;
  endByte: number;
  preview: string;
  citation: EvidenceCitation;
  disclosure?: string;
}

export interface EvidenceVerifyInput {
  requester: EvidenceRequester;
  conversationId: string;
  evidenceId: string;
  startByte: number;
  endByte: number;
  contentDigest: string;
  providerWindowTokens?: number;
}

export interface EvidenceCompareInput {
  requester: EvidenceRequester;
  conversationId: string;
  left: { evidenceId: string; startByte: number; endByte: number };
  right: { evidenceId: string; startByte: number; endByte: number };
  providerWindowTokens?: number;
}

/** Conversation-scoped authenticated evidence reads with content-free audit events. */
export class EvidenceRetrievalService {
  private readonly now: () => number;
  private readonly quarantinedEvidence = new Set<string>();

  constructor(private readonly options: EvidenceRetrievalServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async list(input: EvidenceListInput): Promise<EvidenceLedgerRecord[]> {
    await this.requireOwnership(input.conversationId, input.requester, 'list');
    const records = await this.options.ledger.listEvidence(input.conversationId, {
      limit: input.limit,
    });
    const allowed: EvidenceLedgerRecord[] = [];
    for (const record of records) {
      const policy = this.authorize(record, input.requester);
      if (policy.allowed) allowed.push(record);
      else await this.audit(input.requester, input.conversationId, 'list', policy.code, [record.id]);
    }
    await this.audit(
      input.requester,
      input.conversationId,
      'list',
      'allowed',
      allowed.map((record) => record.id),
    );
    return allowed;
  }

  async getCard(input: EvidenceGetCardInput): Promise<ContextEvidenceCardResponse> {
    return retrieveEvidenceCard(input, { ...this.options, now: this.now });
  }

  async read(input: EvidenceReadInput): Promise<EvidenceRetrievalResponse> {
    await this.requireOwnership(input.conversationId, input.requester, 'read');
    const record = await this.requireRecord(
      input.conversationId,
      input.evidenceId,
      input.requester,
      'read',
    );
    const disclosure = await this.requirePolicy(record, input.requester, 'read');
    const tokenLimit = await this.requireReadRange(input, record);
    const plaintext = await this.readAuthenticatedRange(
      record, input.startByte, input.endByte, input.requester, 'read',
    );
    try {
      let selected: { bytes: Uint8Array; text: string };
      try {
        selected = boundedUtf8Slice(plaintext, tokenLimit, this.options.estimateTokens);
      } catch (error) {
        const code = error instanceof EvidenceRetrievalError ? error.code : 'RANGE_UTF8_INVALID';
        return this.deny(
          input.requester, input.conversationId, 'read', code, [record.id],
          [{ startByte: input.startByte, endByte: input.endByte }],
        );
      }
      const digest = await this.options.blobStore.deriveCitationDigest(
        selected.bytes,
        record.keyVersion ?? undefined,
      );
      const content = wrapUntrustedEvidence(record.id, selected.text);
      const response: EvidenceRetrievalResponse = {
        evidenceId: record.id,
        startByte: input.startByte,
        endByte: input.startByte + selected.bytes.byteLength,
        content,
        tokenCount: this.options.estimateTokens(content),
        tokenLimit,
        truncated: selected.bytes.byteLength < input.endByte - input.startByte,
        citation: {
          evidenceId: record.id,
          startByte: input.startByte,
          endByte: input.startByte + selected.bytes.byteLength,
          contentDigest: digest,
        },
        captureCompleteness: record.captureCompleteness,
        ...(disclosure ? { disclosure } : limitationDisclosure(record)),
      };
      await this.audit(input.requester, input.conversationId, 'read', 'allowed', [record.id], [{
        startByte: response.startByte,
        endByte: response.endByte,
      }]);
      return response;
    } finally {
      plaintext.fill(0);
    }
  }

  async search(input: EvidenceSearchInput): Promise<EvidenceSearchMatch[]> {
    await this.requireOwnership(input.conversationId, input.requester, 'search');
    const query = input.query.trim();
    const queryBytes = new TextEncoder().encode(query);
    if (!query || queryBytes.byteLength > MAX_SEARCH_QUERY_BYTES) {
      return this.deny(input.requester, input.conversationId, 'search', 'SEARCH_QUERY_INVALID');
    }
    let tokenLimit: number;
    try {
      tokenLimit = this.requireTokenLimit(input.tokenLimit, input.providerWindowTokens);
    } catch (error) {
      const code = error instanceof EvidenceRetrievalError ? error.code : 'TOKEN_LIMIT_INVALID';
      return this.deny(input.requester, input.conversationId, 'search', code);
    }
    const [records, cards] = await Promise.all([
      this.options.ledger.listEvidence(input.conversationId, { limit: MAX_SEARCH_RECORDS }),
      this.options.ledger.listEvidenceCards(input.conversationId, { limit: MAX_SEARCH_RECORDS }),
    ]);
    const matches: EvidenceSearchMatch[] = [];
    const readable = new Map<string, {
      record: EvidenceLedgerRecord;
      disclosures: string[];
    }>();
    for (const record of records) {
      const policy = this.authorize(record, input.requester);
      if (policy.allowed && isReadableRecord(record)) {
        readable.set(record.id, { record, disclosures: policy.disclosures });
      } else if (!policy.allowed) {
        await this.audit(input.requester, input.conversationId, 'search', policy.code, [record.id]);
      }
    }
    for (const card of cards) {
        const parent = readable.get(card.evidenceId);
        if (!parent || card.blobRef === null) continue;
        const cardPayload = await this.readCardPayload(card);
        if (!cardPayload || !cardPayload.summary.includes(query)) continue;
        const cited = cardPayload.citations.find((candidate) =>
          candidate.evidenceId === parent.record.id
          && isValidEvidenceRange(candidate.startByte, candidate.endByte, parent.record.byteCount)
        );
        if (!cited) continue;
        const citedBytes = await this.readAuthenticatedRange(
          parent.record, cited.startByte, cited.endByte, input.requester, 'search',
        );
        const verified = await this.options.blobStore.verifyCitationDigest(
          citedBytes, cited.contentDigest, parent.record.keyVersion ?? undefined,
        ).finally(() => citedBytes.fill(0));
        if (!verified) continue;
        matches.push({
          matchKind: 'card',
          evidenceId: parent.record.id,
          startByte: cited.startByte,
          endByte: cited.endByte,
          preview: wrapUntrustedEvidence(
            parent.record.id,
            boundedEvidenceText(cardPayload.summary, tokenLimit, this.options.estimateTokens),
          ),
          citation: cited,
          ...(parent.disclosures.length > 0
            ? { disclosure: parent.disclosures.join(' ') }
            : limitationDisclosure(parent.record)),
        });
    }
    for (const { record, disclosures } of readable.values()) {
      const found = await this.findAuthenticated(
        record, queryBytes, tokenLimit * MAX_RANGE_BYTES_PER_TOKEN, input.requester, 'search',
      );
      if (!found) continue;
      try {
        const selected = boundedUtf8Slice(
          trimIncompleteUtf8Suffix(found.bytes), tokenLimit, this.options.estimateTokens,
        );
        const digest = await this.options.blobStore.deriveCitationDigest(
          selected.bytes,
          record.keyVersion ?? undefined,
        );
        matches.push({
          matchKind: 'raw',
          evidenceId: record.id,
          startByte: found.startByte,
          endByte: found.startByte + selected.bytes.byteLength,
          preview: wrapUntrustedEvidence(record.id, selected.text),
          citation: {
            evidenceId: record.id,
            startByte: found.startByte,
            endByte: found.startByte + selected.bytes.byteLength,
            contentDigest: digest,
          },
          ...(disclosures.length > 0
            ? { disclosure: disclosures.join(' ') }
            : limitationDisclosure(record)),
        });
      } finally {
        found.bytes.fill(0);
      }
    }
    await this.audit(
      input.requester,
      input.conversationId,
      'search',
      'allowed',
      matches.map((match) => match.evidenceId),
      matches.map((match) => ({ startByte: match.startByte, endByte: match.endByte })),
    );
    return matches;
  }

  private async readCardPayload(card: EvidenceCardMetadataRecord): Promise<{
    summary: string;
    citations: EvidenceCitation[];
  } | null> {
    try {
      const bytes = await this.options.blobStore.read(card.blobRef!);
      try {
        const payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
        const cardValue = asRecord(payload['card']);
        const citations = cardValue?.['citations'];
        const summary = cardValue?.['summary'];
        if (
          payload['format'] !== 'aio-evidence-card-v1'
          || payload['trustBoundary'] !== 'untrusted-source-material'
          || typeof summary !== 'string'
          || !Array.isArray(citations)
        ) return null;
        const parsedCitations = citations.filter(isEvidenceCitation);
        return parsedCitations.length === citations.length
          ? { summary, citations: parsedCitations }
          : null;
      } finally {
        bytes.fill(0);
      }
    } catch {
      return null;
    }
  }

  async verify(input: EvidenceVerifyInput): Promise<{ verified: boolean }> {
    await this.requireOwnership(input.conversationId, input.requester, 'verify');
    const record = await this.requireRecord(
      input.conversationId,
      input.evidenceId,
      input.requester,
      'verify',
    );
    await this.requirePolicy(record, input.requester, 'verify');
    await this.requireBoundedRange(
      record, input.startByte, input.endByte, input.providerWindowTokens,
      input.requester, 'verify', input.conversationId,
    );
    const bytes = await this.readAuthenticatedRange(
      record, input.startByte, input.endByte, input.requester, 'verify',
    );
    try {
      const verified = await this.options.blobStore.verifyCitationDigest(
        bytes,
        input.contentDigest,
        record.keyVersion ?? undefined,
      );
      await this.audit(
        input.requester,
        input.conversationId,
        'verify',
        verified ? 'verified' : 'DIGEST_MISMATCH',
        [record.id],
        [{ startByte: input.startByte, endByte: input.endByte }],
      );
      return { verified };
    } finally {
      bytes.fill(0);
    }
  }

  async compare(input: EvidenceCompareInput): Promise<{
    equal: boolean;
    leftCitation: EvidenceCitation;
    rightCitation: EvidenceCitation;
  }> {
    await this.requireOwnership(input.conversationId, input.requester, 'compare');
    const left = await this.requireRecord(
      input.conversationId, input.left.evidenceId, input.requester, 'compare',
    );
    const right = await this.requireRecord(
      input.conversationId, input.right.evidenceId, input.requester, 'compare',
    );
    await this.requirePolicy(left, input.requester, 'compare');
    await this.requirePolicy(right, input.requester, 'compare');
    await this.requireBoundedRange(
      left, input.left.startByte, input.left.endByte, input.providerWindowTokens,
      input.requester, 'compare', input.conversationId,
    );
    await this.requireBoundedRange(
      right, input.right.startByte, input.right.endByte, input.providerWindowTokens,
      input.requester, 'compare', input.conversationId,
    );
    const [leftBytes, rightBytes] = await Promise.all([
      this.readAuthenticatedRange(
        left, input.left.startByte, input.left.endByte, input.requester, 'compare',
      ),
      this.readAuthenticatedRange(
        right, input.right.startByte, input.right.endByte, input.requester, 'compare',
      ),
    ]);
    try {
      const equal = leftBytes.byteLength === rightBytes.byteLength
        && timingSafeEqual(Buffer.from(leftBytes), Buffer.from(rightBytes));
      const [leftDigest, rightDigest] = await Promise.all([
        this.options.blobStore.deriveCitationDigest(leftBytes, left.keyVersion ?? undefined),
        this.options.blobStore.deriveCitationDigest(rightBytes, right.keyVersion ?? undefined),
      ]);
      const leftCitation = citation(left.id, input.left.startByte, input.left.endByte, leftDigest);
      const rightCitation = citation(right.id, input.right.startByte, input.right.endByte, rightDigest);
      await this.audit(
        input.requester,
        input.conversationId,
        'compare',
        equal ? 'equal' : 'different',
        [left.id, right.id],
        [input.left, input.right],
      );
      return { equal, leftCitation, rightCitation };
    } finally {
      leftBytes.fill(0);
      rightBytes.fill(0);
    }
  }

  private async requireOwnership(
    conversationId: string,
    requester: EvidenceRequester,
    operation: EvidenceAccessLogInput['operation'],
  ): Promise<void> {
    if (conversationId.trim()) return;
    await this.deny(requester, conversationId, operation, 'OWNERSHIP_REQUIRED');
  }

  private async requireRecord(
    conversationId: string,
    evidenceId: string,
    requester: EvidenceRequester,
    operation: EvidenceAccessLogInput['operation'],
  ): Promise<EvidenceLedgerRecord> {
    if (this.quarantinedEvidence.has(evidenceKey(conversationId, evidenceId))) {
      return this.deny(requester, conversationId, operation, 'EVIDENCE_CORRUPT', [evidenceId]);
    }
    const record = await this.options.ledger.getEvidence(conversationId, evidenceId);
    if (record && isReadableRecord(record)) return record;
    return this.deny(requester, conversationId, operation, 'EVIDENCE_NOT_FOUND', [evidenceId]);
  }

  private async requirePolicy(
    record: EvidenceLedgerRecord,
    requester: EvidenceRequester,
    operation: EvidenceAccessLogInput['operation'],
  ): Promise<string | undefined> {
    const policy = this.authorize(record, requester);
    if (policy.allowed) return policy.disclosures.join(' ') || undefined;
    return this.deny(requester, record.conversationId, operation, policy.code, [record.id]);
  }

  private async requireReadRange(input: EvidenceReadInput, record: EvidenceLedgerRecord): Promise<number> {
    try {
      validateEvidenceRange(input.startByte, input.endByte, record.byteCount);
    } catch (error) {
      const code = error instanceof EvidenceRetrievalError ? error.code : 'RANGE_INVALID';
      return this.deny(input.requester, input.conversationId, 'read', code, [record.id]);
    }
    let tokenLimit: number;
    try {
      tokenLimit = this.requireTokenLimit(input.tokenLimit, input.providerWindowTokens);
    } catch (error) {
      const code = error instanceof EvidenceRetrievalError ? error.code : 'TOKEN_LIMIT_INVALID';
      return this.deny(input.requester, input.conversationId, 'read', code, [record.id]);
    }
    if (input.endByte - input.startByte > tokenLimit * MAX_RANGE_BYTES_PER_TOKEN) {
      return this.deny(
        input.requester, input.conversationId, 'read', 'RANGE_TOO_LARGE', [record.id],
        [{ startByte: input.startByte, endByte: input.endByte }],
      );
    }
    return tokenLimit;
  }

  private async requireBoundedRange(
    record: EvidenceLedgerRecord,
    startByte: number,
    endByte: number,
    providerWindowTokens: number | undefined,
    requester: EvidenceRequester,
    operation: EvidenceAccessLogInput['operation'],
    conversationId: string,
  ): Promise<void> {
    try {
      validateEvidenceRange(startByte, endByte, record.byteCount);
    } catch (error) {
      const code = error instanceof EvidenceRetrievalError ? error.code : 'RANGE_INVALID';
      return this.deny(requester, conversationId, operation, code, [record.id]);
    }
    const maxBytes = calculateEvidenceRangeTokenBudget(providerWindowTokens)
      * MAX_RANGE_BYTES_PER_TOKEN;
    if (endByte - startByte > maxBytes) {
      return this.deny(
        requester, conversationId, operation, 'RANGE_TOO_LARGE', [record.id],
        [{ startByte, endByte }],
      );
    }
  }

  private requireTokenLimit(requested: number, providerWindowTokens?: number): number {
    if (!Number.isSafeInteger(requested) || requested <= 0) {
      throw new EvidenceRetrievalError('TOKEN_LIMIT_INVALID');
    }
    const bounded = Math.min(requested, calculateEvidenceRangeTokenBudget(providerWindowTokens));
    if (this.options.estimateTokens(wrapUntrustedEvidence('range', 'x')) > bounded) {
      throw new EvidenceRetrievalError('TOKEN_LIMIT_TOO_SMALL');
    }
    return bounded;
  }

  private async readAuthenticatedRange(
    record: EvidenceLedgerRecord,
    startByte: number,
    endByte: number,
    requester: EvidenceRequester,
    operation: EvidenceAccessLogInput['operation'],
  ): Promise<Uint8Array> {
    try {
      return await this.options.blobStore.readRange(
        record.blobRef!, record.keyedContentId!, startByte, endByte,
      );
    } catch (error) {
      return this.handleReadFailure(error, record, requester, operation);
    }
  }

  private async findAuthenticated(
    record: EvidenceLedgerRecord,
    query: Uint8Array,
    maxResultBytes: number,
    requester: EvidenceRequester,
    operation: EvidenceAccessLogInput['operation'],
  ): Promise<{ startByte: number; bytes: Uint8Array } | null> {
    try {
      return await this.options.blobStore.find(
        record.blobRef!, record.keyedContentId!, query, maxResultBytes,
      );
    } catch (error) {
      return this.handleReadFailure(error, record, requester, operation);
    }
  }

  private async handleReadFailure<T>(
    error: unknown,
    record: EvidenceLedgerRecord,
    requester: EvidenceRequester,
    operation: EvidenceAccessLogInput['operation'],
  ): Promise<T> {
    if (isIntegrityFailure(error)) {
      this.quarantinedEvidence.add(evidenceKey(record.conversationId, record.id));
      const persisted = await this.options.ledger.failEvidence({
        evidenceId: record.id,
        conversationId: record.conversationId,
        status: 'corrupt',
        updatedAt: this.now(),
      }).then(() => true, () => false);
      if (!persisted) await this.options.blobStore.remove(record.blobRef!).catch(() => undefined);
      return this.deny(requester, record.conversationId, operation, 'EVIDENCE_CORRUPT', [record.id]);
    }
    return this.deny(requester, record.conversationId, operation, 'EVIDENCE_READ_FAILED', [record.id]);
  }

  private authorize(record: EvidenceLedgerRecord, requester: EvidenceRequester) {
    return this.options.policy.authorize({
      requester,
      sensitivity: record.sensitivity,
      sourceKind: record.sourceKind,
      observedAt: record.completedAt ?? record.createdAt,
      now: this.now(),
    });
  }

  private async deny(
    requester: EvidenceRequester,
    conversationId: string,
    operation: EvidenceAccessLogInput['operation'],
    outcomeCode: string,
    evidenceIds: string[] = [],
    requestedRanges: { startByte: number; endByte: number }[] = [],
  ): Promise<never> {
    await this.audit(requester, conversationId, operation, outcomeCode, evidenceIds, requestedRanges);
    throw new EvidenceRetrievalError(outcomeCode);
  }

  private async audit(
    requester: EvidenceRequester,
    conversationId: string,
    operation: EvidenceAccessLogInput['operation'],
    outcomeCode: string,
    evidenceIds: string[] = [],
    requestedRanges: { startByte: number; endByte: number }[] = [],
  ): Promise<void> {
    try {
      await this.options.ledger.logEvidenceAccess({
        requester: requester.id,
        conversationId,
        operation,
        evidenceIds,
        requestedRanges,
        outcomeCode,
        createdAt: this.now(),
      });
    } catch {
      throw new EvidenceRetrievalError('EVIDENCE_AUDIT_FAILED');
    }
  }
}

function isReadableRecord(record: EvidenceLedgerRecord): boolean {
  return record.status === 'complete'
    && record.blobRef !== null
    && record.keyedContentId !== null
    && record.keyVersion !== null;
}

function citation(
  evidenceId: string,
  startByte: number,
  endByte: number,
  contentDigest: string,
): EvidenceCitation {
  return { evidenceId, startByte, endByte, contentDigest };
}

function limitationDisclosure(record: EvidenceLedgerRecord): { disclosure: string } | object {
  if (record.captureCompleteness === 'complete') return {};
  return {
    disclosure: record.truncationReason
      ?? `Evidence capture is ${record.captureCompleteness}; complete coverage is unavailable.`,
  };
}

function isIntegrityFailure(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'BLOB_AUTH_FAILED'
    || code === 'BLOB_DIGEST_MISMATCH'
    || code === 'BLOB_FORMAT_INVALID'
    || code === 'BLOB_NOT_FOUND'
    || code === 'KEY_VERSION_UNAVAILABLE';
}

function evidenceKey(conversationId: string, evidenceId: string): string {
  return `${conversationId}\u0000${evidenceId}`;
}
