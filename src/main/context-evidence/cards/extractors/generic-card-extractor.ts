import type {
  EvidenceCard,
  EvidenceCitation,
  EvidenceFinding,
} from '@contracts/types/context-evidence';
import type { EvidenceLedgerRecord } from '../../../conversation-ledger/context-evidence-ledger.types';

const FALLBACK_RANGE_BYTES = 256;

export interface CardExtractionContext {
  record: EvidenceLedgerRecord;
  content: Uint8Array;
  createCitation(startByte: number, endByte: number): Promise<EvidenceCitation>;
}

export interface EvidenceCardDraft {
  extractorKind: string;
  extractorVersion: string;
  status: EvidenceCard['status'];
  summary: string;
  findings: EvidenceFinding[];
  citations: EvidenceCitation[];
  freshness?: EvidenceCard['freshness'];
  contradictions: EvidenceCard['contradictions'];
  derivedBy: EvidenceCard['derivedBy'];
}

export interface EvidenceCardExtractor {
  readonly sourceKind: EvidenceLedgerRecord['sourceKind'] | 'generic';
  readonly version: string;
  extract(context: CardExtractionContext): Promise<EvidenceCardDraft>;
}

export type JsonObject = Record<string, unknown>;

export class GenericCardExtractor implements EvidenceCardExtractor {
  readonly sourceKind = 'generic';
  readonly version = 'generic-v1';

  async extract(context: CardExtractionContext): Promise<EvidenceCardDraft> {
    const findings: EvidenceFinding[] = [];
    if (context.content.byteLength > 0) {
      const headEnd = Math.min(FALLBACK_RANGE_BYTES, context.content.byteLength);
      findings.push(await rangeFinding(
        context,
        'raw-head',
        'Authenticated raw head range is available.',
        0,
        headEnd,
      ));
      findings.push(await rangeFinding(
        context,
        'raw-tail',
        'Authenticated raw tail range is available.',
        Math.max(0, context.content.byteLength - FALLBACK_RANGE_BYTES),
        context.content.byteLength,
      ));
    }
    return makeDraft(
      context,
      'generic',
      this.version,
      'partial',
      `No deterministic summary was derived. Retrieve authenticated raw evidence by reference ${context.record.id}.`,
      findings,
    );
  }
}

export function parseJsonObject(context: CardExtractionContext): JsonObject {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(context.content);
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CARD_EXTRACTION_INPUT_INVALID');
  }
  return parsed as JsonObject;
}

export async function jsonFieldFinding(
  context: CardExtractionContext,
  object: JsonObject,
  field: string,
  statement: (value: unknown) => string | null,
  kind: EvidenceFinding['kind'] = 'fact',
  importance: EvidenceFinding['importance'] = 'info',
): Promise<EvidenceFinding | null> {
  if (!(field in object)) return null;
  const renderedStatement = statement(object[field]);
  if (!renderedStatement) return null;
  const range = findJsonFieldValueRange(context.content, field, object[field]);
  if (!range) return null;
  const citation = await context.createCitation(range.startByte, range.endByte);
  return {
    id: `field-${field}`,
    kind,
    statement: renderedStatement,
    importance,
    citations: [citation],
  };
}

export function makeDraft(
  context: CardExtractionContext,
  extractorKind: string,
  extractorVersion: string,
  status: EvidenceCard['status'],
  summary: string,
  findings: EvidenceFinding[],
  freshness?: EvidenceCard['freshness'],
): EvidenceCardDraft {
  const limitation = limitationDisclosure(context.record);
  return {
    extractorKind,
    extractorVersion,
    status,
    summary: limitation ? `${summary} ${limitation}` : summary,
    findings,
    citations: uniqueCitations(findings.flatMap((finding) => finding.citations)),
    ...(freshness ? { freshness } : {}),
    contradictions: [],
    derivedBy: { kind: 'deterministic', version: extractorVersion },
  };
}

export function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 2_000
    ? value
    : null;
}

export function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

export function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return null;
  return value;
}

function findJsonFieldValueRange(
  content: Uint8Array,
  field: string,
  value: unknown,
): { startByte: number; endByte: number } | null {
  const bytes = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  const keyBytes = Buffer.from(JSON.stringify(field), 'utf8');
  const valueJson = JSON.stringify(value);
  if (valueJson === undefined) return null;
  const keyStarts: number[] = [];
  let searchFrom = 0;
  while (searchFrom < bytes.byteLength) {
    const found = bytes.indexOf(keyBytes, searchFrom);
    if (found < 0) break;
    keyStarts.push(found);
    searchFrom = found + keyBytes.byteLength;
  }
  if (keyStarts.length !== 1) return null;
  const keyStart = keyStarts[0] as number;
  const valueBytes = Buffer.from(valueJson, 'utf8');
  let valueStart = keyStart + keyBytes.byteLength;
  while (isJsonWhitespace(bytes[valueStart])) valueStart += 1;
  if (bytes[valueStart] !== 0x3a) return null;
  valueStart += 1;
  while (isJsonWhitespace(bytes[valueStart])) valueStart += 1;
  if (!bytes.subarray(valueStart, valueStart + valueBytes.byteLength).equals(valueBytes)) return null;
  return { startByte: valueStart, endByte: valueStart + valueBytes.byteLength };
}

function isJsonWhitespace(value: number | undefined): boolean {
  return value === 0x20 || value === 0x09 || value === 0x0a || value === 0x0d;
}

export function limitationDisclosure(record: EvidenceLedgerRecord): string | null {
  if (record.captureCompleteness === 'complete') return null;
  const reason = record.truncationReason ?? 'No limitation reason was recorded.';
  return record.captureCompleteness === 'bounded'
    ? `Limitation: This card covers only a bounded capture and does not represent the complete source. ${reason}`
    : `Limitation: This card covers metadata only and does not represent the complete source. ${reason}`;
}

function uniqueCitations(citations: EvidenceCitation[]): EvidenceCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = `${citation.evidenceId}:${citation.startByte}:${citation.endByte}:${citation.contentDigest}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function rangeFinding(
  context: CardExtractionContext,
  id: string,
  statement: string,
  startByte: number,
  endByte: number,
): Promise<EvidenceFinding> {
  return {
    id,
    kind: 'fact',
    statement,
    importance: 'info',
    citations: [await context.createCitation(startByte, endByte)],
  };
}
