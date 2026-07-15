import type { EvidenceFinding } from '@contracts/types/context-evidence';
import {
  jsonFieldFinding,
  makeDraft,
  parseJsonObject,
  stringValue,
  type CardExtractionContext,
  type EvidenceCardExtractor,
} from './generic-card-extractor';

export class BrowserCardExtractor implements EvidenceCardExtractor {
  readonly sourceKind = 'browser';
  readonly version = 'browser-v1';

  async extract(context: CardExtractionContext) {
    const value = parseJsonObject(context);
    const candidates = await Promise.all([
      stringFinding(context, value, 'url', 'Browser URL'),
      stringFinding(context, value, 'pageIdentity', 'Browser page identity'),
      stringFinding(context, value, 'visibleState', 'Browser visible state'),
      stringFinding(context, value, 'action', 'Browser action', 'change'),
      stringFinding(context, value, 'outcome', 'Browser interaction outcome', 'verification'),
    ]);
    const findings = candidates.filter((finding): finding is EvidenceFinding => finding !== null);
    return makeDraft(context, this.sourceKind, this.version,
      findings.length > 0 ? 'validated' : 'partial',
      'Deterministic browser evidence fields were extracted.', findings);
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
