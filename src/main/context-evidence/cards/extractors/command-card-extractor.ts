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

export class CommandCardExtractor implements EvidenceCardExtractor {
  readonly sourceKind = 'command';
  readonly version = 'command-v1';

  async extract(context: CardExtractionContext) {
    const value = parseJsonObject(context);
    const candidates = await Promise.all([
      jsonFieldFinding(context, value, 'commandClass', (field) => {
        const text = stringValue(field);
        return text ? `Command class: ${text}.` : null;
      }),
      jsonFieldFinding(context, value, 'exitStatus', (field) => {
        const status = nonNegativeInteger(field);
        return status === null ? null : `Exit status: ${status}.`;
      }, 'verification'),
      jsonFieldFinding(context, value, 'durationMs', (field) => {
        const duration = nonNegativeInteger(field);
        return duration === null ? null : `Command duration: ${duration}ms.`;
      }),
      jsonFieldFinding(context, value, 'changedPaths', (field) => {
        const paths = stringArray(field);
        return paths ? `Changed paths: ${paths.length}.` : null;
      }, 'change'),
      jsonFieldFinding(context, value, 'testCount', (field) => {
        const count = nonNegativeInteger(field);
        return count === null ? null : `Tests reported: ${count}.`;
      }, 'verification'),
      jsonFieldFinding(context, value, 'warningCount', (field) => {
        const count = nonNegativeInteger(field);
        return count === null ? null : `Warnings reported: ${count}.`;
      }, 'warning', 'warning'),
      jsonFieldFinding(context, value, 'error', (field) => (
        stringValue(field) ? 'Command error was reported.' : null
      ), 'error', 'critical'),
    ]);
    const findings = candidates.filter((finding): finding is EvidenceFinding => finding !== null);
    return makeDraft(
      context,
      this.sourceKind,
      this.version,
      findings.length > 0 ? 'validated' : 'partial',
      'Deterministic command evidence fields were extracted.',
      findings,
    );
  }
}
