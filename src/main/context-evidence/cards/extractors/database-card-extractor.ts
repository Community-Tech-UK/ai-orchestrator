import type { EvidenceFinding } from '@contracts/types/context-evidence';
import {
  jsonFieldFinding,
  makeDraft,
  nonNegativeInteger,
  parseJsonObject,
  stringArray,
  stringValue,
  type CardExtractionContext,
  type EvidenceCardExtractor,
} from './generic-card-extractor';

export class DatabaseCardExtractor implements EvidenceCardExtractor {
  readonly sourceKind = 'database';
  readonly version = 'database-v1';

  async extract(context: CardExtractionContext) {
    const value = parseJsonObject(context);
    const candidates = await Promise.all([
      jsonFieldFinding(context, value, 'queryIdentity', (field) => (
        stringValue(field) ? 'Authenticated database query identity was reported.' : null
      )),
      jsonFieldFinding(context, value, 'columns', (field) => {
        const columns = stringArray(field);
        return columns ? `Database columns reported: ${columns.length}.` : null;
      }),
      countFinding(context, value, 'rowCount', 'Database row count'),
      countFinding(context, value, 'selectedRows', 'Selected rows included'),
      jsonFieldFinding(context, value, 'truncated', (field) => (
        field === true ? 'Database result was truncated.' : field === false
          ? 'Database result was marked untruncated.' : null
      ), 'warning', 'warning'),
    ]);
    const findings = candidates.filter((finding): finding is EvidenceFinding => finding !== null);
    return makeDraft(context, this.sourceKind, this.version,
      findings.length > 0 ? 'validated' : 'partial',
      'Deterministic database evidence fields were extracted.', findings);
  }
}

function countFinding(
  context: CardExtractionContext,
  value: Record<string, unknown>,
  field: string,
  label: string,
) {
  return jsonFieldFinding(context, value, field, (raw) => {
    const count = nonNegativeInteger(raw);
    return count === null ? null : `${label}: ${count}.`;
  });
}
