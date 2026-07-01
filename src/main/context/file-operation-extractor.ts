export type FileOperationKind = 'read' | 'write' | 'edit' | 'delete' | 'move' | 'execute';

export interface FileOperation {
  readonly kind: FileOperationKind;
  readonly path: string;
  readonly source: 'tool-call' | 'tool-output' | 'assistant-text';
}

interface FileOperationTurn {
  readonly role?: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly toolCalls?: readonly {
    readonly name: string;
    readonly input: string;
    readonly output?: string;
  }[];
}

const TOOL_KIND_BY_NAME: Readonly<Record<string, FileOperationKind>> = {
  read: 'read',
  read_file: 'read',
  readfile: 'read',
  edit: 'edit',
  multiedit: 'edit',
  edit_file: 'edit',
  editfile: 'edit',
  write: 'write',
  write_file: 'write',
  createfile: 'write',
};

const PROSE_KIND_PATTERNS: readonly [FileOperationKind, RegExp][] = [
  ['delete', /\b(?:delete|deleted|remove|removed)\b/i],
  ['move', /\b(?:move|moved|rename|renamed)\b/i],
  ['write', /\b(?:add|added|create|created|generate|generated|write|wrote)\b/i],
  ['edit', /\b(?:change|changed|edit|edited|fix|fixed|modify|modified|refactor|refactored|update|updated)\b/i],
  ['execute', /\b(?:execute|executed|run|ran)\b/i],
  ['read', /\b(?:inspect|inspected|open|opened|read|review|reviewed|view|viewed)\b/i],
];

const FUTURE_INTENT_RE = /\b(?:going to|need to|needs to|next|plan to|should|todo|will)\b/i;

const PATH_TOKEN_RE =
  /(?<![\w@.-])((?:\.{1,2}[\\/]|~[\\/]|\/|[A-Za-z]:[\\/])?[A-Za-z0-9_@+()[\].-]+(?:[\\/][A-Za-z0-9_@+()[\].-]+)*\.[A-Za-z0-9][A-Za-z0-9_-]{0,11})(?![\w@-])/g;

const EXTENSIONLESS_PATH_RE =
  /(?<![\w@.-])((?:\.{1,2}[\\/]|~[\\/]|\/|[A-Za-z]:[\\/])?(?:[A-Za-z0-9_@+()[\].-]+[\\/])*(?:Dockerfile|Makefile|Rakefile|Gemfile|Procfile|Brewfile|Justfile|Taskfile|Vagrantfile|\.env(?:\.[A-Za-z0-9_-]+)?))(?![\w@-])/g;

const KEYED_PATH_RE =
  /(?:file_path|filePath|path|filename)\s*[:=]\s*["']?([^"',}\]\s]+)["']?/gi;

const SHELL_COMMAND_RE =
  /^\s*(?:\$|>\s*)?\s*(?:rm|mv|cp|git|node|tsx|ts-node|python3?|bash|sh|sed|tee|cat|rg|grep)\b/;

function normalizeToolName(toolName: string): string {
  return toolName.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function cleanupPath(rawPath: string): string | null {
  const trimmed = rawPath
    .trim()
    .replace(/^[`"'([{<]+/, '')
    .replace(/[.`"',;:)\]}>]+$/, '');

  if (!trimmed || trimmed.startsWith('-')) return null;
  if (/^[^/\s]+@[^/\s]+\.[^/\s]+$/.test(trimmed)) return null;
  if (/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

function collectPathTokens(line: string): string[] {
  const paths: string[] = [];

  for (const match of line.matchAll(KEYED_PATH_RE)) {
    const path = cleanupPath(match[1]);
    if (path) paths.push(path);
  }

  for (const match of line.matchAll(PATH_TOKEN_RE)) {
    const path = cleanupPath(match[1]);
    if (path) paths.push(path);
  }

  for (const match of line.matchAll(EXTENSIONLESS_PATH_RE)) {
    const path = cleanupPath(match[1]);
    if (path) paths.push(path);
  }

  return [...new Set(paths)];
}

function addOperation(
  operations: FileOperation[],
  seen: Set<string>,
  kind: FileOperationKind,
  path: string,
  source: FileOperation['source']
): void {
  const key = `${kind}\0${path}`;
  if (seen.has(key)) return;
  seen.add(key);
  operations.push({ kind, path, source });
}

function inferToolOperation(line: string): { kind: FileOperationKind; paths: string[] } | null {
  const match = /^\s*(?:tool:)?([A-Za-z_][A-Za-z0-9_-]*)\b/i.exec(line);
  if (!match) return null;

  const kind = TOOL_KIND_BY_NAME[normalizeToolName(match[1])];
  if (!kind) return null;

  const paths = collectPathTokens(line);
  return paths.length > 0 ? { kind, paths } : null;
}

function extractShellOperations(line: string): readonly Omit<FileOperation, 'source'>[] {
  if (!SHELL_COMMAND_RE.test(line)) return [];

  const operations: Omit<FileOperation, 'source'>[] = [];
  const paths = collectPathTokens(line);
  const trimmed = line.trim().replace(/^\$\s*/, '');

  if (/^rm\b/.test(trimmed)) {
    for (const path of paths) operations.push({ kind: 'delete', path });
    return operations;
  }

  if (/^mv\b/.test(trimmed)) {
    const destination = paths.at(-1);
    return destination ? [{ kind: 'move', path: destination }] : [];
  }

  if (/^cp\b/.test(trimmed)) {
    const destination = paths.at(-1);
    return destination ? [{ kind: 'write', path: destination }] : [];
  }

  if (/^git\s+diff\b/.test(trimmed)) {
    for (const path of paths) operations.push({ kind: 'read', path });
    return operations;
  }

  if (/^(?:node|tsx|ts-node|python3?|bash|sh)\b/.test(trimmed)) {
    const executable = paths[0];
    return executable ? [{ kind: 'execute', path: executable }] : [];
  }

  if (/\btee\b/.test(trimmed) || />>?\s*\S+/.test(trimmed)) {
    const target = paths.at(-1);
    return target ? [{ kind: 'write', path: target }] : [];
  }

  if (/^sed\b/.test(trimmed) && /\s-i(?:\s|$)/.test(trimmed)) {
    const target = paths.at(-1);
    return target ? [{ kind: 'edit', path: target }] : [];
  }

  if (/^(?:cat|rg|grep)\b/.test(trimmed)) {
    for (const path of paths) operations.push({ kind: 'read', path });
  }

  return operations;
}

function inferProseKind(line: string): FileOperationKind | null {
  const futureIntentIndex = FUTURE_INTENT_RE.exec(line)?.index ?? Number.POSITIVE_INFINITY;

  for (const [kind, pattern] of PROSE_KIND_PATTERNS) {
    const operationMatch = pattern.exec(line);
    if (!operationMatch) continue;
    return futureIntentIndex < operationMatch.index ? null : kind;
  }
  return null;
}

function appendFileOperations(
  input: string,
  operations: FileOperation[],
  seen: Set<string>,
  sourceOverride?: FileOperation['source']
): void {
  for (const line of input.split(/\r?\n/)) {
    const toolOperation = inferToolOperation(line);
    if (toolOperation) {
      for (const path of toolOperation.paths) {
        addOperation(operations, seen, toolOperation.kind, path, sourceOverride ?? 'tool-call');
      }
      continue;
    }

    const shellOperations = extractShellOperations(line);
    if (shellOperations.length > 0) {
      for (const operation of shellOperations) {
        addOperation(operations, seen, operation.kind, operation.path, sourceOverride ?? 'tool-output');
      }
      continue;
    }

    const proseKind = inferProseKind(line);
    if (!proseKind) continue;

    for (const path of collectPathTokens(line)) {
      addOperation(operations, seen, proseKind, path, sourceOverride ?? 'assistant-text');
    }
  }
}

export function extractFileOperations(input: string): readonly FileOperation[] {
  const operations = new Array<FileOperation>();
  const seen = new Set<string>();

  appendFileOperations(input, operations, seen);

  return operations;
}

export function extractFileOperationsFromTurns(
  turns: readonly FileOperationTurn[]
): readonly FileOperation[] {
  const operations = new Array<FileOperation>();
  const seen = new Set<string>();

  for (const turn of turns) {
    const proseFragment = !turn.role || turn.role === 'assistant' ? turn.content : '';
    if (proseFragment) {
      appendFileOperations(proseFragment, operations, seen);
    }

    for (const toolCall of turn.toolCalls ?? []) {
      appendFileOperations(`${toolCall.name} ${toolCall.input}`, operations, seen, 'tool-call');
      if (toolCall.output) {
        appendFileOperations(toolCall.output, operations, seen, 'tool-output');
      }
    }
  }

  return operations;
}

export function summarizeFileOperations(
  operations: readonly FileOperation[],
  maxItems = 40
): string {
  if (operations.length === 0) return '- (none)';

  const visible = operations.slice(0, maxItems);
  const lines = visible.map(operation =>
    `- ${operation.kind}: ${operation.path} (${operation.source})`
  );

  const omitted = operations.length - visible.length;
  if (omitted > 0) {
    lines.push(`- ...and ${omitted} more file operation(s)`);
  }

  return lines.join('\n');
}
