/**
 * Files the native CLI already loads, so AIO must not prepend them again.
 *
 * Conservative: only skip kinds we know that provider reads. Unknown or empty
 * providers keep today's prepend. Pure function of provider + paths + file
 * text — no timestamps — so the WS-B4 prompt-cache prefix stays byte-stable.
 */

import * as path from 'node:path';
import type { InstructionSourceKind } from '../../../shared/types/instruction-source.types';

export interface NativeInstructionSource {
  path: string;
  kind: InstructionSourceKind;
  loaded: boolean;
  applied: boolean;
  reason?: string;
}

export interface NativeInstructionOwnershipOptions {
  provider?: string;
  sources: readonly NativeInstructionSource[];
  readFile(filePath: string): string | null;
  homeDir?: string;
}

function normalizePath(value: string): string {
  return path.normalize(path.resolve(value));
}

function normalizeProvider(provider?: string): string {
  return provider?.trim().toLowerCase() ?? '';
}

/** Whole-line Claude `@path` imports, including `~/` and relative paths. */
export function collectClaudeAtImportPaths(
  fromPath: string,
  content: string,
  homeDir = '',
): string[] {
  const directory = path.dirname(fromPath);
  const imports: string[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('@') || line.startsWith('@http://') || line.startsWith('@https://')) {
      continue;
    }
    const raw = line.slice(1).trim();
    if (!raw || /\s/.test(raw)) {
      continue;
    }
    if (raw === '~' || raw.startsWith('~/')) {
      if (!homeDir) {
        continue;
      }
      imports.push(normalizePath(path.join(homeDir, raw.slice(2))));
      continue;
    }
    imports.push(normalizePath(path.isAbsolute(raw) ? raw : path.resolve(directory, raw)));
  }
  return imports;
}

function claudeOwnedPaths(
  sources: readonly NativeInstructionSource[],
  readFile: (filePath: string) => string | null,
  homeDir: string,
): Set<string> {
  const owned = new Set<string>();
  const queue: string[] = [];
  for (const source of sources) {
    if (!source.loaded || source.kind !== 'claude') {
      continue;
    }
    const normalized = normalizePath(source.path);
    owned.add(normalized);
    queue.push(normalized);
  }

  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const content = readFile(current);
    if (content === null) {
      continue;
    }
    for (const imported of collectClaudeAtImportPaths(current, content, homeDir)) {
      owned.add(imported);
      queue.push(imported);
    }
  }
  return owned;
}

/**
 * Canonical paths AIO should not prepend because the native CLI already
 * injects them. Intersection with the resolved stack is the caller's job.
 */
export function nativeOwnedInstructionPaths(
  options: NativeInstructionOwnershipOptions,
): Set<string> {
  const provider = normalizeProvider(options.provider);
  if (!provider) {
    return new Set();
  }

  const skipKinds = new Set<InstructionSourceKind>();
  if (provider === 'claude') {
    return claudeOwnedPaths(options.sources, options.readFile, options.homeDir ?? '');
  }
  if (provider === 'codex' || provider === 'cursor') {
    skipKinds.add('agents');
  } else if (provider === 'gemini' || provider === 'antigravity') {
    skipKinds.add('gemini');
  } else if (provider === 'copilot') {
    skipKinds.add('copilot');
  } else {
    return new Set();
  }

  const owned = new Set<string>();
  for (const source of options.sources) {
    if (source.loaded && skipKinds.has(source.kind)) {
      owned.add(normalizePath(source.path));
    }
  }
  return owned;
}

export interface OmitNativeOwnedResolution<T extends NativeInstructionSource> {
  mergedContent: string;
  sources: T[];
}

/**
 * Mark native-owned sources unapplied and drop their merged parts, preserving
 * positional pairing with `mergedContent` split on `\n\n---\n\n`.
 */
export function omitNativeOwnedInstructionStack<T extends NativeInstructionSource>(
  resolution: OmitNativeOwnedResolution<T>,
  provider: string | undefined,
  readFile: (filePath: string) => string | null,
  homeDir?: string,
): OmitNativeOwnedResolution<T> {
  const owned = nativeOwnedInstructionPaths({
    provider,
    sources: resolution.sources,
    readFile,
    homeDir,
  });
  if (owned.size === 0) {
    return resolution;
  }

  const applied = resolution.sources.filter((source) => source.loaded && source.applied);
  const parts = resolution.mergedContent ? resolution.mergedContent.split('\n\n---\n\n') : [];
  const keptParts: string[] = [];
  for (let index = 0; index < applied.length; index += 1) {
    const source = applied[index];
    if (!source || owned.has(normalizePath(source.path))) {
      continue;
    }
    const part = parts[index];
    if (part !== undefined) {
      keptParts.push(part);
    }
  }

  return {
    mergedContent: keptParts.join('\n\n---\n\n'),
    sources: resolution.sources.map((source) => {
      if (!source.applied || !owned.has(normalizePath(source.path))) {
        return source;
      }
      return {
        ...source,
        applied: false,
        reason: 'Skipped: the native CLI already loads this file.',
      };
    }),
  };
}
