import type { ImageResolveKind } from '../../../../shared/types/instance.types';

export interface ExtractedImageReference {
  kind: ImageResolveKind;
  src: string;
  alt?: string;
}

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\((<[^>]+>|[^)\r\n]+)\)/g;
const FENCED_CODE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const BULLET_PREFIX_RE = /^(?:>\s*)?(?:[-*+]\s+|\d+\.\s+)/;
const REMOTE_IMAGE_RE = /^https?:\/\/\S+$/i;
const DATA_IMAGE_RE = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=:-]+)*,.+$/i;
const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;
const POSIX_ABSOLUTE_PATH_RE = /^\//;
const HOME_PATH_RE = /^~\//;
const FILE_URL_RE = /^file:\/\//i;

const ALLOWED_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.avif',
]);

export function extractImageReferences(content: string): ExtractedImageReference[] {
  if (!content.trim()) {
    return [];
  }

  const masked = maskCode(content);
  const refs: ExtractedImageReference[] = [];
  const seen = new Set<string>();
  const mutable = masked.split('');

  for (const match of masked.matchAll(MARKDOWN_IMAGE_RE)) {
    const full = match[0];
    const alt = match[1]?.trim() || undefined;
    const rawSrc = match[2]?.trim() ?? '';
    const src = unwrapAngleBrackets(rawSrc);
    const kind = detectKind(src);
    if (!kind) {
      continue;
    }

    const dedupeKey = `${kind}:${src}`;
    if (!seen.has(dedupeKey)) {
      refs.push({ kind, src, alt });
      seen.add(dedupeKey);
    }

    const start = match.index ?? 0;
    for (let i = start; i < start + full.length; i++) {
      mutable[i] = ' ';
    }
  }

  for (const line of mutable.join('').split(/\r?\n/)) {
    const candidate = normalizeBareCandidate(line);
    if (!candidate) {
      continue;
    }

    const kind = detectKind(candidate);
    if (!kind) {
      continue;
    }

    const dedupeKey = `${kind}:${candidate}`;
    if (!seen.has(dedupeKey)) {
      refs.push({ kind, src: candidate });
      seen.add(dedupeKey);
    }
  }

  return refs;
}

function maskCode(content: string): string {
  return content
    .replace(FENCED_CODE_RE, (match) => ' '.repeat(match.length))
    .replace(INLINE_CODE_RE, (match) => ' '.repeat(match.length));
}

function normalizeBareCandidate(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const withoutPrefix = trimmed.replace(BULLET_PREFIX_RE, '').trim();
  if (!withoutPrefix) {
    return null;
  }

  return unwrapAngleBrackets(withoutPrefix);
}

function unwrapAngleBrackets(value: string): string {
  if (value.startsWith('<') && value.endsWith('>')) {
    return value.slice(1, -1).trim();
  }
  return value.trim();
}

function detectKind(src: string): ImageResolveKind | null {
  if (DATA_IMAGE_RE.test(src)) {
    return 'data';
  }
  if (REMOTE_IMAGE_RE.test(src)) {
    return 'remote';
  }
  if (looksLikeLocalImagePath(src)) {
    return 'local';
  }
  return null;
}

function looksLikeLocalImagePath(src: string): boolean {
  if (!(FILE_URL_RE.test(src) || POSIX_ABSOLUTE_PATH_RE.test(src) || HOME_PATH_RE.test(src) || WINDOWS_ABSOLUTE_PATH_RE.test(src))) {
    return false;
  }

  return ALLOWED_IMAGE_EXTENSIONS.has(extensionFromSource(src));
}

function extensionFromSource(src: string): string {
  const normalized = src.split(/[?#]/, 1)[0];
  const lastSlash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  const basename = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const dotIndex = basename.lastIndexOf('.');
  return dotIndex >= 0 ? basename.slice(dotIndex).toLowerCase() : '';
}
