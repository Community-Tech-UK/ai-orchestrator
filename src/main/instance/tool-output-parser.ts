/**
 * ToolOutputParser – Extracts file paths that a tool_use message will write to.
 *
 * Only `tool_use` messages are processed; all other message types are ignored.
 * Read-only tools are skipped so that we only track mutations.
 * Returned paths are absolute and either inside workingDirectory or user-facing
 * artifacts outside it. Outside code files are ignored.
 */

import * as path from 'path';
import type { OutputMessage } from '../../shared/types/instance.types';
import { isArtifactPath } from '../../shared/utils/artifact-extensions';

// ---------------------------------------------------------------------------
// Read-only tool names (skip – they never mutate files)
// ---------------------------------------------------------------------------

const READ_ONLY_TOOLS = new Set([
  // Claude
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Agent',
  'TodoWrite',
  'LS',
  // Codex / Gemini / generic
  'ListFiles',
  'SearchFiles',
  'read_file',
  'list_dir',
  'grep',
  'list_directory',
  'search_files',
  // Copilot
  'readFile',
  'listFiles',
  'searchFiles',
]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolves `p` relative to `workingDirectory` when it is relative, then
 * returns the absolute path only if it lives inside `workingDirectory` or is a
 * user-facing artifact. Outside code files stay ignored.
 * Returns `null` otherwise.
 */
function resolveWithinDir(p: unknown, workingDirectory: string): string | null {
  if (typeof p !== 'string' || p.trim() === '') return null;

  const abs = path.isAbsolute(p) ? p : path.resolve(workingDirectory, p);
  const normalised = path.normalize(abs);
  const base = path.normalize(workingDirectory);

  if (normalised === base || normalised.startsWith(base + path.sep)) {
    return normalised;
  }
  if (isArtifactPath(normalised)) {
    return normalised;
  }
  return null;
}

/**
 * Extracts file paths from shell-style command strings.
 * Handles: output redirection (> / >>), tee, sed -i, mv, cp.
 */
function extractFromCommand(command: string, workingDirectory: string): string[] {
  const found: string[] = [];

  // 1. Output redirection:  cmd > file  or  cmd >> file
  //    Match '>>' before '>' so the longer token wins.
  const redirectRe = />>?\s*(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = redirectRe.exec(command)) !== null) {
    const resolved = resolveWithinDir(m[1], workingDirectory);
    if (resolved) found.push(resolved);
  }

  // 2. tee:  tee [-a] file
  const teeRe = /\btee\b(?:\s+-a)?\s+(\S+)/g;
  while ((m = teeRe.exec(command)) !== null) {
    const resolved = resolveWithinDir(m[1], workingDirectory);
    if (resolved) found.push(resolved);
  }

  // 3. sed -i:  sed -i [suffix] 's/.../.../' file
  const sedRe = /\bsed\b\s+(?:-i(?:\s+\S+)?\s+)?(?:'[^']*'|"[^"]*")\s+(\S+)/g;
  while ((m = sedRe.exec(command)) !== null) {
    const resolved = resolveWithinDir(m[1], workingDirectory);
    if (resolved) found.push(resolved);
  }

  // 4. mv / cp:  mv src dst  or  cp src dst  (destination is the write target)
  const mvCpRe = /\b(?:mv|cp)\b\s+\S+\s+(\S+)/g;
  while ((m = mvCpRe.exec(command)) !== null) {
    const resolved = resolveWithinDir(m[1], workingDirectory);
    if (resolved) found.push(resolved);
  }

  return found;
}

/**
 * Parses a unified diff patch (Codex apply_patch) and extracts destination paths.
 */
function extractFromPatch(patch: string, workingDirectory: string): string[] {
  const found: string[] = [];

  for (const line of patch.split('\n')) {
    // +++ b/path  (unified diff destination)
    const plusMatch = /^\+\+\+\s+(?:b\/)?(.+)$/.exec(line.trimEnd());
    if (plusMatch) {
      const p = plusMatch[1].split('\t')[0].trim();
      if (p !== '/dev/null') {
        const resolved = resolveWithinDir(p, workingDirectory);
        if (resolved) found.push(resolved);
      }
      continue;
    }

    // rename to <path>
    const renameMatch = /^rename to\s+(.+)$/.exec(line.trimEnd());
    if (renameMatch) {
      const resolved = resolveWithinDir(renameMatch[1].trim(), workingDirectory);
      if (resolved) found.push(resolved);
      continue;
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// Provider-specific extractors
// ---------------------------------------------------------------------------

type ToolInput = Record<string, unknown>;

function extractClaude(toolName: string, input: ToolInput, workingDirectory: string): string[] {
  switch (toolName) {
    case 'Write':
    case 'Edit': {
      const resolved = resolveWithinDir(input['file_path'], workingDirectory);
      return resolved ? [resolved] : [];
    }
    case 'MultiEdit': {
      const edits = input['edits'];
      if (!Array.isArray(edits)) return [];
      return edits.flatMap((e: unknown) => {
        if (e && typeof e === 'object') {
          const resolved = resolveWithinDir(
            (e as Record<string, unknown>)['file_path'],
            workingDirectory
          );
          return resolved ? [resolved] : [];
        }
        return [];
      });
    }
    case 'Bash': {
      const cmd = input['command'];
      if (typeof cmd !== 'string') return [];
      return extractFromCommand(cmd, workingDirectory);
    }
    default:
      return [];
  }
}

function extractCodex(toolName: string, input: ToolInput, workingDirectory: string): string[] {
  switch (toolName) {
    case 'write_file': {
      const resolved = resolveWithinDir(input['path'], workingDirectory);
      return resolved ? [resolved] : [];
    }
    case 'apply_patch': {
      const patch = input['patch'];
      if (typeof patch !== 'string') return [];
      return extractFromPatch(patch, workingDirectory);
    }
    case 'shell': {
      const cmd = input['command'];
      if (typeof cmd !== 'string') return [];
      return extractFromCommand(cmd, workingDirectory);
    }
    default:
      return [];
  }
}

function extractGemini(toolName: string, input: ToolInput, workingDirectory: string): string[] {
  switch (toolName) {
    case 'edit_file':
    case 'write_file': {
      const resolved = resolveWithinDir(input['path'], workingDirectory);
      return resolved ? [resolved] : [];
    }
    case 'shell': {
      const cmd = input['command'];
      if (typeof cmd !== 'string') return [];
      return extractFromCommand(cmd, workingDirectory);
    }
    default:
      return [];
  }
}

function extractCopilot(toolName: string, input: ToolInput, workingDirectory: string): string[] {
  switch (toolName) {
    case 'editFile':
    case 'createFile': {
      const resolved = resolveWithinDir(input['path'], workingDirectory);
      return resolved ? [resolved] : [];
    }
    case 'runCommand': {
      const cmd = input['command'];
      if (typeof cmd !== 'string') return [];
      return extractFromCommand(cmd, workingDirectory);
    }
    default:
      return [];
  }
}

/**
 * Generic fallback that probes common field names found across providers.
 */
function extractGeneric(input: ToolInput, workingDirectory: string): string[] {
  const found: string[] = [];

  for (const key of ['file_path', 'path', 'filePath', 'filename']) {
    const val = input[key];
    if (typeof val === 'string') {
      const resolved = resolveWithinDir(val, workingDirectory);
      if (resolved) found.push(resolved);
    }
  }

  for (const key of ['command', 'cmd']) {
    const val = input[key];
    if (typeof val === 'string') {
      found.push(...extractFromCommand(val, workingDirectory));
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extracts the set of file paths that a `tool_use` or `tool_result` message is
 * about to write or has just written.
 *
 * @param message          The output message to inspect.
 * @param workingDirectory Absolute path to the instance working directory.
 * @param provider         CLI provider hint ('claude' | 'codex' | 'gemini' | 'copilot' | ...).
 * @returns                Deduplicated list of absolute paths to track.
 */
export function extractFilePaths(
  message: OutputMessage,
  workingDirectory: string,
  provider: string
): string[] {
  if (message.type !== 'tool_use' && message.type !== 'tool_result') return [];

  const meta = message.metadata;
  if (!meta) return [];

  const toolName = typeof meta['name'] === 'string' ? meta['name'] : '';
  const rawInput = meta['input'];
  const input: ToolInput =
    rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? (rawInput as ToolInput)
      : {};

  if (READ_ONLY_TOOLS.has(toolName)) return [];

  const lowerProvider = provider.toLowerCase();
  let paths: string[];

  if (lowerProvider === 'claude') {
    paths = extractClaude(toolName, input, workingDirectory);
  } else if (lowerProvider === 'codex') {
    paths = extractCodex(toolName, input, workingDirectory);
  } else if (lowerProvider === 'gemini') {
    paths = extractGemini(toolName, input, workingDirectory);
  } else if (lowerProvider === 'copilot') {
    paths = extractCopilot(toolName, input, workingDirectory);
  } else {
    paths = extractGeneric(input, workingDirectory);
  }

  // If provider-specific extraction yielded nothing, try the generic fallback
  if (paths.length === 0) {
    paths = extractGeneric(input, workingDirectory);
  }

  return [...new Set(paths)];
}

/**
 * Class wrapper around `extractFilePaths` for use as an injectable instance.
 */
export class ToolOutputParser {
  extractFilePaths(
    message: OutputMessage,
    workingDirectory: string,
    provider: string
  ): string[] {
    return extractFilePaths(message, workingDirectory, provider);
  }
}
