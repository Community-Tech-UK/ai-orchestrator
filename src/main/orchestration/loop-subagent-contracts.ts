import { createLoopPendingInput, type LoopPendingInput } from '../../shared/types/loop.types';

export interface LoopTaskPacket {
  id: string;
  objective: string;
  scope: {
    read: string[];
    write: string[];
  };
  acceptanceCriteria: string[];
  verificationPlan: string[];
  depth: number;
}

export interface LoopSubagentReturn {
  scope: string[];
  result: string;
  keyFiles: string[];
  issues: string[];
}

export interface LoopSubagentResultInput {
  taskId: string;
  summary: string;
  keyFiles: string[];
  issues: string[];
}

export interface TaskPacketValidationOptions {
  maxDepth?: number;
  requireNonOverlappingWriteScopes?: boolean;
}

export type TaskPacketValidationResult =
  | { ok: true; packets: LoopTaskPacket[] }
  | { ok: false; errors: string[] };

function normalizeScopePath(path: unknown): string {
  if (typeof path !== 'string') return '.';
  const cleaned = path.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  return cleaned || '.';
}

export function writeScopesOverlap(a: string, b: string): boolean {
  const left = normalizeScopePath(a);
  const right = normalizeScopePath(b);
  if (left === '.' || right === '.') return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === 'string') ? value : null;
}

function packetLabel(packet: unknown, index: number): string {
  if (!isRecord(packet)) return `packet[${index}]`;
  const id = packet['id'];
  return typeof id === 'string' && id.trim() ? id.trim() : `packet[${index}]`;
}

function validatePacket(packet: unknown, index: number, maxDepth: number, errors: string[]): LoopTaskPacket | null {
  const label = packetLabel(packet, index);
  if (!isRecord(packet)) {
    errors.push(`${label}: packet must be an object`);
    return null;
  }

  const rawId = packet['id'];
  const rawObjective = packet['objective'];
  const rawScope = packet['scope'];
  const rawDepth = packet['depth'];
  const id = isNonEmptyString(rawId) ? rawId.trim() : '';
  if (!id) errors.push(`${label}: id is required`);
  const objective = isNonEmptyString(rawObjective) ? rawObjective.trim() : '';
  if (!objective) errors.push(`${label}: objective is required`);

  const scope = isRecord(rawScope) ? rawScope : undefined;
  const read = stringArray(scope?.['read']);
  const write = stringArray(scope?.['write']);
  if (!read) errors.push(`${label}: scope.read is required`);
  if (!write) errors.push(`${label}: scope.write is required`);

  const acceptanceCriteria = stringArray(packet['acceptanceCriteria']);
  const verificationPlan = stringArray(packet['verificationPlan']);
  if (!acceptanceCriteria?.some(isNonEmptyString)) {
    errors.push(`${label}: acceptanceCriteria must include at least one item`);
  }
  if (!verificationPlan?.some(isNonEmptyString)) {
    errors.push(`${label}: verificationPlan must include at least one item`);
  }
  if (!Number.isInteger(rawDepth) || (rawDepth as number) < 0 || (rawDepth as number) > maxDepth) {
    errors.push(`${label}: depth exceeds maxDepth ${maxDepth}`);
  }
  if (
    !id ||
    !objective ||
    !read ||
    !write ||
    !acceptanceCriteria?.some(isNonEmptyString) ||
    !verificationPlan?.some(isNonEmptyString) ||
    !Number.isInteger(rawDepth) ||
    (rawDepth as number) < 0 ||
    (rawDepth as number) > maxDepth
  ) {
    return null;
  }
  return {
    id,
    objective,
    scope: { read, write },
    acceptanceCriteria,
    verificationPlan,
    depth: rawDepth as number,
  };
}

function writeScopeFor(packet: LoopTaskPacket): string[] {
  return Array.isArray(packet.scope?.write) ? packet.scope.write.filter(isNonEmptyString) : [];
}

export function validateLoopTaskPackets(
  packets: readonly unknown[],
  options: TaskPacketValidationOptions = {},
): TaskPacketValidationResult {
  const errors: string[] = [];
  const validPackets: LoopTaskPacket[] = [];
  const maxDepth = options.maxDepth ?? 1;
  const requireNonOverlappingWriteScopes = options.requireNonOverlappingWriteScopes ?? true;

  packets.forEach((packet, index) => {
    const validated = validatePacket(packet, index, maxDepth, errors);
    if (validated) validPackets.push(validated);
  });
  if (requireNonOverlappingWriteScopes) {
    for (let i = 0; i < validPackets.length; i++) {
      for (let j = i + 1; j < validPackets.length; j++) {
        for (const left of writeScopeFor(validPackets[i])) {
          for (const right of writeScopeFor(validPackets[j])) {
            if (writeScopesOverlap(left, right)) {
              errors.push(`${validPackets[i].id} and ${validPackets[j].id}: write scope overlap (${left} vs ${right})`);
            }
          }
        }
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, packets: validPackets };
}

function parseSection(body: string, heading: string, next: string): string {
  const match = new RegExp(`${heading}:\\s*([\\s\\S]*?)(?=\\n${next}:|$)`, 'i').exec(body);
  if (!match) throw new Error(`Missing required "${heading}:" section`);
  const content = match[1].trim();
  if (!content) throw new Error(`Empty required "${heading}:" section`);
  return content;
}

function parseList(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ''))
    .filter(Boolean);
}

export function parseLoopSubagentReturn(text: string): LoopSubagentReturn {
  const scope = parseSection(text, 'Scope', 'Result');
  const result = parseSection(text, 'Result', 'Key files');
  const keyFiles = parseSection(text, 'Key files', 'Issues');
  const issues = parseSection(text, 'Issues', '$');
  return {
    scope: parseList(scope),
    result,
    keyFiles: parseList(keyFiles),
    issues: parseList(issues),
  };
}

export function buildSubagentResultPendingInput(result: LoopSubagentResultInput): LoopPendingInput {
  const keyFiles = result.keyFiles.length ? result.keyFiles.join(', ') : 'none';
  const issues = result.issues.length ? result.issues.join('; ') : 'none';
  return createLoopPendingInput(
    [
      `Subagent result for ${result.taskId}: ${result.summary}`,
      `Key files: ${keyFiles}`,
      `Issues: ${issues}`,
      'Use this result as fresh input; do NOT poll or duplicate the subagent work.',
    ].join('\n'),
    { kind: 'queue', source: 'subagent-result' },
  );
}
