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

export class FileCardExtractor implements EvidenceCardExtractor {
  readonly sourceKind = 'file';
  readonly version = 'file-v1';

  async extract(context: CardExtractionContext) {
    const value = parseJsonObject(context);
    const candidates = await Promise.all([
      stringFinding(context, value, 'canonicalPath', 'File path'),
      stringFinding(context, value, 'contentIdentity', 'File content identity'),
      jsonFieldFinding(context, value, 'lineCount', (field) => {
        const count = nonNegativeInteger(field);
        return count === null ? null : `File line count: ${count}.`;
      }),
      stringFinding(context, value, 'lineRange', 'File line range'),
      stringFinding(context, value, 'parseStatus', 'File parse status', 'verification'),
    ]);
    const findings = candidates.filter((finding): finding is EvidenceFinding => finding !== null);
    return makeDraft(context, this.sourceKind, this.version,
      findings.length > 0 ? 'validated' : 'partial',
      'Deterministic file evidence fields were extracted.', findings);
  }
}

function stringFinding(
  context: CardExtractionContext,
  value: Record<string, unknown>,
  field: string,
  label: string,
  kind: EvidenceFinding['kind'] = 'fact',
) {
  return jsonFieldFinding(context, value, field, (raw) => {
    const text = stringValue(raw);
    return text ? `${label}: ${text}.` : null;
  }, kind);
}
