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

export class McpCardExtractor implements EvidenceCardExtractor {
  readonly sourceKind = 'mcp';
  readonly version = 'mcp-v1';

  async extract(context: CardExtractionContext) {
    const value = parseJsonObject(context);
    const candidates = await Promise.all([
      stringFinding(context, value, 'server', 'MCP server'),
      stringFinding(context, value, 'tool', 'MCP tool'),
      stringFinding(context, value, 'status', 'MCP status', 'verification'),
      jsonFieldFinding(context, value, 'resultCount', (field) => {
        const count = nonNegativeInteger(field);
        return count === null ? null : `MCP results reported: ${count}.`;
      }),
    ]);
    const findings = candidates.filter((finding): finding is EvidenceFinding => finding !== null);
    return makeDraft(context, this.sourceKind, this.version,
      findings.length > 0 ? 'validated' : 'partial',
      'Deterministic MCP evidence fields were extracted.', findings);
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
