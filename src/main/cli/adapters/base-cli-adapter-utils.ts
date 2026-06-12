import { statSync } from 'fs';

/**
 * JSON.stringify that escapes U+2028 and U+2029.
 * These are valid JSON but act as line terminators in JavaScript,
 * silently splitting NDJSON messages when present in string values.
 */
export function ndjsonSafeStringify(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Upper bound (chars) on each input considered by the similarity helper. Inputs
 * longer than this are truncated before trigram extraction so the comparison
 * stays O(bounded) on the degraded-output path rather than O(n) in the full
 * response size.
 */
const SIMILARITY_MAX_CHARS = 16_384;

export function computeBoundedTrigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const sa = a.length > SIMILARITY_MAX_CHARS ? a.slice(0, SIMILARITY_MAX_CHARS) : a;
  const sb = b.length > SIMILARITY_MAX_CHARS ? b.slice(0, SIMILARITY_MAX_CHARS) : b;

  const trigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i + 3 <= s.length; i++) {
      set.add(s.slice(i, i + 3));
    }
    return set;
  };

  const ta = trigrams(sa);
  const tb = trigrams(sb);
  if (ta.size === 0 || tb.size === 0) {
    return 0;
  }

  let intersection = 0;
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const gram of small) {
    if (large.has(gram)) intersection++;
  }
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * True when `path` exists and is a directory. Returns false for missing
 * paths, plain files, and platform-foreign paths that cannot be statted
 * (e.g. a `C:\...` Windows path on macOS).
 */
export function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Thrown by `BaseCliAdapter.spawnProcess()` when the configured working
 * directory does not exist. Node reports a nonexistent cwd as
 * `spawn <cmd> ENOENT`, which is indistinguishable from a missing binary —
 * this error converts that misleading failure into an actionable one.
 *
 * The classic trigger: a *remote-node* instance's working directory
 * (e.g. `C:\Users\...` from a Windows node) leaking into a locally-spawned
 * helper CLI (cross-model review, warm-start).
 */
export class CliSpawnCwdError extends Error {
  readonly command: string;
  readonly cwd: string;

  constructor(command: string, cwd: string) {
    super(`Working directory does not exist: ${cwd} (cannot spawn ${command})`);
    this.name = 'CliSpawnCwdError';
    this.command = command;
    this.cwd = cwd;
  }
}

/**
 * Disambiguates Node's opaque `spawn <cmd> ENOENT` (missing binary vs missing
 * cwd vs non-executable binary) into a message that says *what* is missing.
 * A `CliSpawnCwdError` is already specific and passes through unchanged.
 */
export function enrichSpawnError(error: Error, command: string, cwd?: string): Error {
  if (error instanceof CliSpawnCwdError) {
    return error;
  }
  if (cwd && !directoryExists(cwd)) {
    return new Error(`Working directory does not exist: ${cwd} (spawning ${command}). Original: ${error.message}`);
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM') {
    return new Error(`CLI binary "${command}" is not executable (${code}). Original: ${error.message}`);
  }
  return new Error(`CLI binary "${command}" not found on PATH. Original: ${error.message}`);
}
