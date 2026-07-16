import { EvidenceCardSchema } from '@contracts/schemas/context-evidence';
import type {
  ContextEvidenceCardResponse,
  EvidenceCard,
} from '@contracts/types/context-evidence';
import type {
  EvidenceAccessLogInput,
  EvidenceLedgerRecord,
} from '../conversation-ledger/context-evidence-ledger.types';
import type { EvidenceAccessPolicy } from './evidence-access-policy';
import {
  calculateEvidenceRangeTokenBudget,
  EvidenceRetrievalError,
  isValidEvidenceRange,
} from './evidence-retrieval-limits';
import type {
  EvidenceGetCardInput,
  EvidenceRetrievalBlobStore,
  EvidenceRetrievalLedger,
} from './evidence-retrieval-service';

export interface EvidenceCardRetrievalOptions {
  ledger: EvidenceRetrievalLedger;
  blobStore: EvidenceRetrievalBlobStore;
  policy: EvidenceAccessPolicy;
  estimateTokens: (text: string) => number;
  now: () => number;
}

/** Retrieves one policy-authorized card through a bounded, audited projection. */
export async function retrieveEvidenceCard(
  input: EvidenceGetCardInput,
  options: EvidenceCardRetrievalOptions,
): Promise<ContextEvidenceCardResponse> {
  if (!input.conversationId.trim()) {
    return deny(input, options, 'OWNERSHIP_REQUIRED');
  }
  let metadata = await options.ledger.getEvidenceCard(input.conversationId, input.cardId);
  if (!metadata) {
    // `EvidenceRecord` metadata does not expose card ids, so callers (the
    // renderer panel in particular) can only key inspection by EVIDENCE id.
    // Resolve the newest card for that evidence within the same conversation —
    // identical ownership scoping and status filters as the direct lookup.
    const cards = await options.ledger.listEvidenceCards(input.conversationId, {
      evidenceId: input.cardId,
      limit: 1,
    });
    metadata = cards[0] ?? null;
  }
  if (!metadata?.blobRef) return deny(input, options, 'EVIDENCE_CARD_NOT_FOUND');
  const record = await options.ledger.getEvidence(input.conversationId, metadata.evidenceId);
  if (!record || !isReadableRecord(record)) {
    return deny(input, options, 'EVIDENCE_NOT_FOUND', [metadata.evidenceId]);
  }
  const decision = options.policy.authorize({
    requester: input.requester,
    sensitivity: record.sensitivity,
    sourceKind: record.sourceKind,
    observedAt: record.completedAt ?? record.createdAt,
    now: options.now(),
  });
  if (!decision.allowed) return deny(input, options, decision.code, [record.id]);
  const tokenLimit = boundedTokenLimit(input.tokenLimit, input.providerWindowTokens);
  let bytes: Uint8Array;
  try {
    bytes = await options.blobStore.read(metadata.blobRef);
  } catch {
    return deny(input, options, 'EVIDENCE_CARD_READ_FAILED', [record.id]);
  }
  try {
    const card = parseStoredCard(bytes, metadata.id, record.id);
    if (!card) return deny(input, options, 'EVIDENCE_CARD_INVALID', [record.id]);
    const bounded = boundCard(card, tokenLimit, options.estimateTokens);
    const disclosures = [
      ...decision.disclosures,
      ...(bounded.truncated
        ? ['Evidence card content was bounded to the requested inspection limit.']
        : []),
    ];
    await audit(input, options, 'allowed', [record.id], bounded.card.citations.map(
      ({ startByte, endByte }) => ({ startByte, endByte }),
    ));
    return {
      card: bounded.card,
      sensitivity: record.sensitivity,
      provenanceTrust: record.provenanceTrust,
      captureCompleteness: record.captureCompleteness,
      tokenCount: bounded.tokenCount,
      tokenLimit,
      truncated: bounded.truncated,
      ...(disclosures.length > 0 ? { disclosure: disclosures.join(' ') } : {}),
    };
  } finally {
    bytes.fill(0);
  }
}

function boundedTokenLimit(requested: number, providerWindowTokens?: number): number {
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new EvidenceRetrievalError('TOKEN_LIMIT_INVALID');
  }
  return Math.min(requested, calculateEvidenceRangeTokenBudget(providerWindowTokens));
}

function parseStoredCard(
  bytes: Uint8Array,
  cardId: string,
  evidenceId: string,
): EvidenceCard | null {
  try {
    const payload = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as Record<string, unknown>;
    if (payload['format'] !== 'aio-evidence-card-v1'
      || payload['trustBoundary'] !== 'untrusted-source-material') return null;
    const parsed = EvidenceCardSchema.safeParse(payload['card']);
    return parsed.success && parsed.data.id === cardId && parsed.data.evidenceId === evidenceId
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}

function boundCard(
  card: EvidenceCard,
  tokenLimit: number,
  estimateTokens: (text: string) => number,
): { card: EvidenceCard; tokenCount: number; truncated: boolean } {
  const count = (candidate: EvidenceCard) => estimateTokens(JSON.stringify(candidate));
  const fullTokenCount = count(card);
  if (fullTokenCount <= tokenLimit) return { card, tokenCount: fullTokenCount, truncated: false };
  let bounded: EvidenceCard = {
    ...card,
    summary: '',
    findings: [],
    citations: [],
    contradictions: [],
  };
  if (count(bounded) > tokenLimit) throw new EvidenceRetrievalError('TOKEN_LIMIT_TOO_SMALL');
  for (const citation of card.citations) {
    const candidate = { ...bounded, citations: [...bounded.citations, citation] };
    if (count(candidate) > tokenLimit) break;
    bounded = candidate;
  }
  const codePoints = Array.from(card.summary);
  let low = 0;
  let high = codePoints.length;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = { ...bounded, summary: codePoints.slice(0, middle).join('') };
    if (count(candidate) <= tokenLimit) {
      bounded = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { card: bounded, tokenCount: count(bounded), truncated: true };
}

function isReadableRecord(record: EvidenceLedgerRecord): boolean {
  return record.status === 'complete'
    && record.blobRef !== null
    && record.keyedContentId !== null
    && record.keyVersion !== null;
}

async function deny(
  input: EvidenceGetCardInput,
  options: EvidenceCardRetrievalOptions,
  outcomeCode: string,
  evidenceIds: string[] = [],
): Promise<never> {
  await audit(input, options, outcomeCode, evidenceIds);
  throw new EvidenceRetrievalError(outcomeCode);
}

async function audit(
  input: EvidenceGetCardInput,
  options: EvidenceCardRetrievalOptions,
  outcomeCode: string,
  evidenceIds: string[] = [],
  requestedRanges: EvidenceAccessLogInput['requestedRanges'] = [],
): Promise<void> {
  try {
    await options.ledger.logEvidenceAccess({
      requester: input.requester.id,
      conversationId: input.conversationId,
      operation: 'get-card',
      evidenceIds,
      requestedRanges,
      outcomeCode,
      createdAt: options.now(),
    });
  } catch {
    throw new EvidenceRetrievalError('EVIDENCE_AUDIT_FAILED');
  }
}

export function isEvidenceCitation(value: unknown): value is import(
  '@contracts/types/context-evidence'
).EvidenceCitation {
  const candidate = asRecord(value);
  return typeof candidate?.['evidenceId'] === 'string'
    && typeof candidate['startByte'] === 'number'
    && typeof candidate['endByte'] === 'number'
    && isValidEvidenceRange(candidate['startByte'], candidate['endByte'], Number.MAX_SAFE_INTEGER)
    && typeof candidate['contentDigest'] === 'string'
    && /^[a-f0-9]{64}$/i.test(candidate['contentDigest']);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
