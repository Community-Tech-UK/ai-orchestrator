import { getSecretAuditLog } from './secret-redaction';
import { detectSecretsInContent, type DetectedSecret } from './secret-detector';

export type EgressContentKind = 'diff' | 'prompt' | 'webhook' | 'memory';

export interface EgressRedactionOptions {
  kind: EgressContentKind;
  /** Keep +, -, and context prefixes so reviewers can still anchor findings. */
  preserveDiffMarkers?: boolean;
  instanceId?: string;
}

export interface EgressRedactionResult {
  content: string;
  secretsFound: boolean;
  secretCount: number;
}

const REDACTION_MARKER = '[REDACTED — potential secret]';

/**
 * Redacts content at a process egress boundary. Diff redaction intentionally
 * replaces the entire affected line: preserving a partial line can leave a
 * secret in surrounding syntax or make a reviewer infer the value.
 */
export function redactForEgress(
  content: string,
  options: EgressRedactionOptions,
): EgressRedactionResult {
  const secrets = collapseOverlappingSecrets(detectSecretsInContent(content));
  if (secrets.length === 0) {
    return { content, secretsFound: false, secretCount: 0 };
  }

  for (const secret of secrets) {
    getSecretAuditLog().record({
      action: 'redact',
      secretType: secret.type,
      secretName: secret.name,
      instanceId: options.instanceId,
      decision: 'redacted',
    });
  }

  const redacted = options.kind === 'diff' && options.preserveDiffMarkers
    ? redactDiffLines(content, secrets)
    : redactSecretRanges(content, secrets);

  return {
    content: redacted,
    secretsFound: true,
    secretCount: secrets.length,
  };
}

function redactDiffLines(content: string, secrets: readonly DetectedSecret[]): string {
  const affectedLineNumbers = new Set<number>();
  for (const secret of secrets) {
    affectedLineNumbers.add(lineNumberAt(content, secret.startIndex));
  }

  return content.split('\n').map((line, index) => {
    if (!affectedLineNumbers.has(index)) return line;
    // File-header markers are not content lines. Keep them intact if a future
    // detector ever happens to match their path text.
    if (line.startsWith('+++') || line.startsWith('---')) return line;
    const marker = /^[+\- ]/.exec(line)?.[0] ?? '';
    return `${marker}${REDACTION_MARKER}`;
  }).join('\n');
}

function redactSecretRanges(content: string, secrets: readonly DetectedSecret[]): string {
  let result = content;
  for (const secret of [...secrets].sort((a, b) => b.startIndex - a.startIndex)) {
    result = `${result.slice(0, secret.startIndex)}${REDACTION_MARKER}${result.slice(secret.endIndex)}`;
  }
  return result;
}

function lineNumberAt(content: string, index: number): number {
  let line = 0;
  for (let offset = 0; offset < index; offset += 1) {
    if (content[offset] === '\n') line += 1;
  }
  return line;
}

/**
 * The detector deliberately has overlapping signatures (for example the PEM
 * prefix rule and the complete PEM block rule). Apply one replacement per
 * unioned range so an inner match cannot splice original secret bytes back
 * into the result after the outer match has been replaced.
 */
function collapseOverlappingSecrets(secrets: readonly DetectedSecret[]): DetectedSecret[] {
  const sorted = [...secrets].sort((a, b) =>
    a.startIndex - b.startIndex || b.endIndex - a.endIndex,
  );
  const collapsed: DetectedSecret[] = [];
  for (const secret of sorted) {
    const previous = collapsed.at(-1);
    if (!previous || secret.startIndex > previous.endIndex) {
      collapsed.push({ ...secret });
      continue;
    }
    previous.endIndex = Math.max(previous.endIndex, secret.endIndex);
  }
  return collapsed;
}
