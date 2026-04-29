export type LinkKind = 'url' | 'file-path' | 'error-trace';

export type FilePathFlavor =
  | 'unix-absolute'
  | 'windows-absolute'
  | 'unc'
  | 'relative';

export interface FilePathMeta {
  flavor: FilePathFlavor;
  line?: number;
  column?: number;
}

export interface ErrorTraceMeta {
  path: string;
  flavor: FilePathFlavor;
  line: number;
  column?: number;
}

export interface LinkRange {
  kind: LinkKind;
  start: number;
  end: number;
  text: string;
  meta?: FilePathMeta | ErrorTraceMeta;
}

export interface DetectLinksOptions {
  kinds?: LinkKind[];
  maxLength?: number;
}

interface RawHit extends LinkRange {
  priority: number;
}

const ALL_KINDS: readonly LinkKind[] = ['url', 'file-path', 'error-trace'];
const DEFAULT_MAX_LENGTH = 65_536;
const TRAILING_PUNCTUATION = /[.,;:)\]>'"]+$/;

const PATTERNS = {
  url: /https?:\/\/[^\s)>"']+/g,
  errorTrace: /\bat\s+((?:[A-Z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|[A-Za-z0-9_-]+[\\/])[^\s]+?):(\d+)(?::(\d+))?/g,
  unixAbs: /(?<![A-Za-z0-9_])\/[A-Za-z0-9_.\-/]+(?::\d+(?::\d+)?)?/g,
  windowsAbs: /(?<![A-Za-z0-9_])[A-Z]:[\\/][A-Za-z0-9_.\-/\\]+(?::\d+(?::\d+)?)?/g,
  unc: /\\\\[A-Za-z0-9_.-]+\\[A-Za-z0-9_.\-/\\]+(?::\d+(?::\d+)?)?/g,
  relative: /(?:\.{1,2}[\\/])?[A-Za-z0-9_-]+(?:[/\\][A-Za-z0-9_-]+)*\.(?:ts|tsx|js|jsx|md|json|html|css|scss|yml|yaml|py|java|go|rs|rb|sh|txt)\b(?::\d+(?::\d+)?)?/g,
} as const;

export function detectLinks(source: string, opts: DetectLinksOptions = {}): LinkRange[] {
  const maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH;
  if (!source || source.length > maxLength) {
    return [];
  }

  const kinds = new Set<LinkKind>(opts.kinds ?? ALL_KINDS);
  const hits: RawHit[] = [];

  if (kinds.has('url')) {
    collectUrls(source, hits);
  }
  if (kinds.has('error-trace')) {
    collectErrorTraces(source, hits);
  }
  if (kinds.has('file-path')) {
    collectFilePaths(source, hits);
  }

  return resolveOverlaps(hits).map(({ priority: _priority, ...hit }) => hit);
}

function collectUrls(source: string, hits: RawHit[]): void {
  for (const match of source.matchAll(PATTERNS.url)) {
    const start = match.index ?? 0;
    const trimmed = trimTrailingPunctuation(start, match[0]);
    hits.push({
      kind: 'url',
      start,
      end: trimmed.end,
      text: trimmed.text,
      priority: 4,
    });
  }
}

function collectErrorTraces(source: string, hits: RawHit[]): void {
  for (const match of source.matchAll(PATTERNS.errorTrace)) {
    const start = match.index ?? 0;
    const rawPath = match[1];
    const trimmed = trimTrailingPunctuation(start, match[0]);
    const line = Number.parseInt(match[2], 10);
    const column = match[3] ? Number.parseInt(match[3], 10) : undefined;
    hits.push({
      kind: 'error-trace',
      start,
      end: trimmed.end,
      text: trimmed.text,
      meta: {
        path: rawPath,
        flavor: pathFlavor(rawPath),
        line,
        column,
      },
      priority: 3,
    });
  }
}

function collectFilePaths(source: string, hits: RawHit[]): void {
  for (const pattern of [PATTERNS.unixAbs, PATTERNS.windowsAbs, PATTERNS.unc, PATTERNS.relative]) {
    for (const match of source.matchAll(pattern)) {
      const start = match.index ?? 0;
      const trimmed = trimTrailingPunctuation(start, match[0]);
      const parsed = parsePathLineCol(trimmed.text);
      hits.push({
        kind: 'file-path',
        start,
        end: trimmed.end,
        text: trimmed.text,
        meta: {
          flavor: pathFlavor(parsed.path),
          line: parsed.line,
          column: parsed.column,
        },
        priority: parsed.path === trimmed.text && pathFlavor(parsed.path) === 'relative' ? 1 : 2,
      });
    }
  }
}

function resolveOverlaps(hits: RawHit[]): RawHit[] {
  hits.sort((left, right) => {
    if (left.start !== right.start) {
      return left.start - right.start;
    }
    const lengthDelta = (right.end - right.start) - (left.end - left.start);
    if (lengthDelta !== 0) {
      return lengthDelta;
    }
    return right.priority - left.priority;
  });

  const accepted: RawHit[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.end <= hit.start || hit.start < cursor) {
      continue;
    }
    accepted.push(hit);
    cursor = hit.end;
  }
  return accepted;
}

function trimTrailingPunctuation(start: number, text: string): { end: number; text: string } {
  const trimmed = text.replace(TRAILING_PUNCTUATION, '');
  return { end: start + trimmed.length, text: trimmed };
}

function pathFlavor(text: string): FilePathFlavor {
  if (text.startsWith('\\\\')) {
    return 'unc';
  }
  if (/^[A-Z]:[\\/]/.test(text)) {
    return 'windows-absolute';
  }
  if (text.startsWith('/')) {
    return 'unix-absolute';
  }
  return 'relative';
}

function parsePathLineCol(text: string): { path: string; line?: number; column?: number } {
  const match = /^(.*?)(?::(\d+)(?::(\d+))?)?$/.exec(text);
  if (!match) {
    return { path: text };
  }
  return {
    path: match[1],
    line: match[2] ? Number.parseInt(match[2], 10) : undefined,
    column: match[3] ? Number.parseInt(match[3], 10) : undefined,
  };
}
