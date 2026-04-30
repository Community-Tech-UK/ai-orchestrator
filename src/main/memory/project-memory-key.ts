import * as fs from 'fs';
import * as path from 'path';
import { normalizeCrossPlatformPath } from '../../shared/utils/cross-platform-path';

function looksLikeWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//');
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export function normalizeProjectMemoryKey(projectPath: string | null | undefined): string {
  const raw = projectPath?.trim();
  if (!raw) {
    return '';
  }

  if (looksLikeWindowsPath(raw)) {
    return normalizeCrossPlatformPath(raw);
  }

  const absolute = path.isAbsolute(raw) ? raw : path.resolve(raw);
  let resolved = path.normalize(absolute);
  try {
    resolved = fs.realpathSync.native(absolute);
  } catch {
    try {
      resolved = fs.realpathSync(absolute);
    } catch {
      // The project may not exist locally yet (remote/worktree restore paths).
      // A normalized absolute path is still a stable same-machine key.
    }
  }

  return normalizeCrossPlatformPath(resolved);
}

export function getProjectMemoryLookupKeys(projectPath: string | null | undefined): string[] {
  const raw = projectPath?.trim() ?? '';
  const normalized = normalizeProjectMemoryKey(raw);
  return unique([normalized, normalizeCrossPlatformPath(raw), raw]);
}

export function projectMemoryKeysEqual(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftKey = normalizeProjectMemoryKey(left);
  const rightKey = normalizeProjectMemoryKey(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

export function projectMemoryPathContains(
  candidatePath: string | null | undefined,
  projectPath: string | null | undefined,
): boolean {
  const candidateKey = normalizeProjectMemoryKey(candidatePath);
  const projectKey = normalizeProjectMemoryKey(projectPath);
  return Boolean(
    candidateKey
    && projectKey
    && (
      candidateKey === projectKey
      || candidateKey.startsWith(`${projectKey}/`)
    ),
  );
}
