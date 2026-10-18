/**
 * Files the native CLI already loads, so AIO must not prepend them again.
 *
 * Conservative: only skip kinds we know that provider reads. Unknown or empty
 * providers keep today's prepend. Pure function of provider + paths + file
 * text — no timestamps — so the WS-B4 prompt-cache prefix stays byte-stable.
 */

import * as path from 'node:path';
import type { InstructionSourceKind, InstructionSourceScope } from '../../../shared/types/instruction-source.types';

export interface NativeInstructionSource {
  path: string;
  kind: InstructionSourceKind;
  scope: InstructionSourceScope;
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
  if (provider === 'codex' || provider === 'cursor' || provider === 'opencode') {
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
    const copilotProjectFile = provider === 'copilot' && (source.scope === 'project' || source.scope === 'path-specific') &&
      (source.kind === 'agents' || source.kind === 'gemini' ||
        (source.kind === 'claude' && path.basename(path.dirname(source.path)) !== '.claude'));
    if (source.loaded && (provider !== 'copilot' || source.scope !== 'user') && (skipKinds.has(source.kind) || copilotProjectFile)) {
      owned.add(normalizePath(source.path));
    }
  }
  return owned;
}

interface InstructionParagraph {
  text: string;
  headingLevel?: number;
}

/** Blank lines inside fenced code remain part of one indivisible paragraph. */
function instructionParagraphs(text: string): InstructionParagraph[] {
  const blocks: InstructionParagraph[] = [];
  let lines: string[] = [];
  let fence: string | undefined;
  const flush = () => {
    const paragraph = lines.join('\n').trim();
    if (paragraph) blocks.push({ text: paragraph });
    lines = [];
  };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      lines.push(line);
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s{0,3}(?:`+|~+)\s*$/.test(line)) {
        fence = undefined;
        flush();
      }
      continue;
    }
    if (marker) {
      flush();
      fence = marker[1];
      lines.push(line);
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+/);
    if (heading) {
      flush();
      blocks.push({ text: line.trim(), headingLevel: heading[1].length });
    } else if (!line.trim()) flush();
    else lines.push(line);
  }
  flush();
  return blocks;
}

/** Remove exact native paragraphs, retaining only headings with surviving content. */
export function removeParagraphsLoadedNatively(text: string, nativeText: string): string {
  const native = new Set(instructionParagraphs(nativeText).filter((block) => !block.headingLevel).map((block) => block.text));
  const output: string[] = [];
  const headings: { text: string; level: number; emitted: boolean }[] = [];
  let removed = false;
  for (const block of instructionParagraphs(text)) {
    if (block.headingLevel) {
      while (headings.length && headings[headings.length - 1].level >= block.headingLevel) headings.pop();
      headings.push({ text: block.text, level: block.headingLevel, emitted: false });
    } else if (native.has(block.text)) removed = true;
    else {
      for (const heading of headings) {
        if (!heading.emitted) { output.push(heading.text); heading.emitted = true; }
      }
      output.push(block.text);
    }
  }
  return removed ? output.join('\n\n') : text;
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
  options: { remote?: boolean } = {},
): OmitNativeOwnedResolution<T> {
  const owned = nativeOwnedInstructionPaths({
    provider,
    sources: resolution.sources,
    readFile,
    homeDir,
  });
  const nativeCodexText = normalizeProvider(provider) === 'codex' && !options.remote && homeDir
    ? readFile(path.join(homeDir, '.codex', 'AGENTS.override.md')) ?? readFile(path.join(homeDir, '.codex', 'AGENTS.md'))
    : null;
  if (owned.size === 0 && nativeCodexText === null) return resolution;

  const applied = resolution.sources.filter((source) => source.loaded && source.applied);
  const parts = resolution.mergedContent ? resolution.mergedContent.split('\n\n---\n\n') : [];
  // A separator inside a file makes positional pairing ambiguous. Keep all
  // instructions rather than removing a different source's governing rules.
  if (parts.length !== applied.length) return resolution;
  const keptParts: string[] = [];
  const paragraphReasons = new Map<string, string>();
  for (let index = 0; index < applied.length; index += 1) {
    const source = applied[index];
    if (!source || owned.has(normalizePath(source.path))) {
      continue;
    }
    const part = parts[index];
    if (part !== undefined) {
      const deduplicated = nativeCodexText === null ? part : removeParagraphsLoadedNatively(part, nativeCodexText);
      if (deduplicated !== part) {
        keptParts.push(`(Paragraphs that Codex already loads from its own AGENTS.md are left out here.)\n\n${deduplicated}`);
        paragraphReasons.set(source.path, 'Paragraphs already loaded from native Codex AGENTS.md were omitted.');
      } else keptParts.push(part);
    }
  }

  return {
    mergedContent: keptParts.join('\n\n---\n\n'),
    sources: resolution.sources.map((source) => {
      if (!source.applied || !owned.has(normalizePath(source.path))) {
        const reason = paragraphReasons.get(source.path);
        return reason ? { ...source, reason } : source;
      }
      return {
        ...source,
        applied: false,
        reason: 'Skipped: the native CLI already loads this file.',
      };
    }),
  };
}
