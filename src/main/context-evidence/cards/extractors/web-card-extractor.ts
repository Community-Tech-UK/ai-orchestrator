import type { EvidenceFinding } from '@contracts/types/context-evidence';
import {
  jsonFieldFinding,
  makeDraft,
  nonNegativeInteger,
  parseJsonObject,
  stringValue,
  type CardExtractionContext,
  type EvidenceCardExtractor,
} from './generic-card-extractor';

export class WebCardExtractor implements EvidenceCardExtractor {
  readonly sourceKind = 'web';
  readonly version = 'web-v1';

  async extract(context: CardExtractionContext) {
    const value = parseJsonObject(context);
    const candidates = await Promise.all([
      stringFinding(context, value, 'canonicalUrl', 'Web URL'),
      stringFinding(context, value, 'title', 'Web title'),
      jsonFieldFinding(context, value, 'statusCode', (field) => {
        const status = nonNegativeInteger(field);
        return status === null ? null : `HTTP status: ${status}.`;
      }, 'verification'),
      timeFinding(context, value, 'retrievedAt', 'Web retrieval time'),
      timeFinding(context, value, 'publishedAt', 'Web publication time'),
    ]);
    const findings = candidates.filter((finding): finding is EvidenceFinding => finding !== null);
    const observedAt = nonNegativeInteger(value['retrievedAt']) ?? context.record.completedAt
      ?? context.record.createdAt;
    const sourcePublishedAt = nonNegativeInteger(value['publishedAt']);
    return makeDraft(
      context,
      this.sourceKind,
      this.version,
      findings.length > 0 ? 'validated' : 'partial',
      'Deterministic web evidence fields were extracted.',
      findings,
      { observedAt, ...(sourcePublishedAt === null ? {} : { sourcePublishedAt }) },
    );
  }
}

function timeFinding(
  context: CardExtractionContext,
  value: Record<string, unknown>,
  field: string,
  label: string,
) {
  return jsonFieldFinding(context, value, field, (raw) => {
    const time = nonNegativeInteger(raw);
    return time === null ? null : `${label}: ${time}.`;
  });
}

function stringFinding(
  context: CardExtractionContext,
  value: Record<string, unknown>,
  field: string,
  label: string,
) {
  return jsonFieldFinding(context, value, field, (raw) => {
    const text = stringValue(raw);
    return text ? `${label}: ${text}.` : null;
  });
}
