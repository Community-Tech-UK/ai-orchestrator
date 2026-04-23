/**
 * Tool Output Truncation - Prevents oversized tool outputs from flooding context windows.
 *
 * Inspired by opencode's truncation pattern. When a tool produces output that exceeds
 * configurable line or byte limits, the full content is written to a temporary file in
 * `{userData}/tool-output/` and a truncated preview is returned along with the file path.
 * Agents can then use the Read tool with offset/limit to examine specific sections.
 *
 * Files are automatically cleaned up after 7 days via `initTruncationCleanup()`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getLogger } from '../logging/logger';

const logger = getLogger('ToolOutputTruncation');

// ---------------------------------------------------------------------------
// Types & interfaces
// ---------------------------------------------------------------------------

/**
 * Result returned by `truncateToolOutput`.
 *
 * When `truncated` is `false`, `content` is the original unmodified text.
 * When `truncated` is `true`, `content` is a shortened preview and `outputPath`
 * is the absolute path to the file containing the full original text.
 */
export type TruncationResult =
  | { content: string; truncated: false }
  | { content: string; truncated: true; outputPath: string };

/**
 * Options that control when and how truncation is applied.
 */
export interface TruncationOptions {
  /**
   * Maximum number of lines to include in the returned preview.
   * Truncation triggers if the text exceeds this OR `maxBytes`.
   * @default 2000
   */
  maxLines: number;

  /**
   * Maximum byte size of the returned preview (50 KB by default).
   * Truncation triggers if the text exceeds this OR `maxLines`.
   * @default 51200
   */
  maxBytes: number;

  /**
   * Which end of the text to keep in the preview.
   * - `'head'` keeps the first N lines / bytes (most useful for structured output).
   * - `'tail'` keeps the last N lines / bytes (most useful for log streams).
   * @default 'head'
   */
  direction: 'head' | 'tail';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS: TruncationOptions = {
  maxLines: 2000,
  maxBytes: 51200,
  direction: 'head',
};

/**
 * Resolve the userData directory at call time so that Electron's `app` object
 * (which is only available after the app is ready) does not need to be
 * accessible at module-load time.
 *
 * Falls back to `~/.orchestrator` when Electron is unavailable (tests, headless).
 */
function getUserDataPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron');
    const userDataPath = app?.getPath?.('userData');
    if (typeof userDataPath === 'string' && userDataPath.length > 0) {
      return userDataPath;
    }
  } catch {
    // Electron not available
  }
  return path.join(os.homedir(), '.orchestrator');
}

/** Lazily-resolved tool-output directory; created on first use. */
let toolOutputDir: string | undefined;
let fallbackToolOutputDir: string | undefined;

/**
 * Returns the tool-output directory, creating it if it does not exist yet.
 */
function getToolOutputDir(): string {
  if (!toolOutputDir) {
    toolOutputDir = path.join(getUserDataPath(), 'tool-output');
    fs.mkdirSync(toolOutputDir, { recursive: true });
  }
  return toolOutputDir;
}

function getFallbackToolOutputDir(): string {
  if (!fallbackToolOutputDir) {
    fallbackToolOutputDir = path.join(os.tmpdir(), 'orchestrator-tool-output');
    fs.mkdirSync(fallbackToolOutputDir, { recursive: true });
  }
  return fallbackToolOutputDir;
}

function writeToolOutputFile(dir: string, id: string, text: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.txt`);
  fs.writeFileSync(filePath, text, 'utf8');
  return filePath;
}

/**
 * Generate a short unique ID for naming output files.
 *
 * Format: `<base36 timestamp>-<6 random chars>`
 * Example: `lk3zq0-a4bc2f`
 */
function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Truncate `text` to at most `maxLines` lines and `maxBytes` bytes, keeping
 * either the head or the tail according to `direction`.
 *
 * Returns the truncated string. Always ends without a trailing newline.
 */
function applyTruncation(text: string, options: TruncationOptions): string {
  const { maxLines, maxBytes, direction } = options;

  if (direction === 'head') {
    const lines = text.split('\n');
    const keptLines = lines.slice(0, maxLines);
    let result = keptLines.join('\n');

    // Further limit by byte size
    if (Buffer.byteLength(result) > maxBytes) {
      result = Buffer.from(result).subarray(0, maxBytes).toString();
      // Avoid splitting a multi-byte character boundary (slice may produce
      // invalid utf8 at the cut point; trim to last safe newline)
      const lastNewline = result.lastIndexOf('\n');
      if (lastNewline > 0) {
        result = result.slice(0, lastNewline);
      }
    }

    return result;
  }

  // tail: keep the last N lines
  const lines = text.split('\n');
  const keptLines = lines.slice(-maxLines);
  let result = keptLines.join('\n');

  // Further limit by byte size (from the tail)
  if (Buffer.byteLength(result) > maxBytes) {
    const buf = Buffer.from(result);
    const tail = buf.subarray(buf.length - maxBytes).toString();
    const firstNewline = tail.indexOf('\n');
    result = firstNewline > 0 ? tail.slice(firstNewline + 1) : tail;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Truncate tool output that exceeds `maxLines` or `maxBytes`.
 *
 * If the text fits within both limits, returns `{ content: text, truncated: false }`.
 *
 * Otherwise the full text is written to `{userData}/tool-output/{id}.txt` and
 * the function returns a truncated preview plus a hint message pointing to the
 * file so that agents can read specific sections with the Read tool.
 *
 * @param text    The raw tool output string.
 * @param options Optional overrides for `TruncationOptions`.
 */
export function truncateToolOutput(
  text: string,
  options?: Partial<TruncationOptions>
): TruncationResult {
  const opts: TruncationOptions = { ...DEFAULT_OPTIONS, ...options };

  const lineCount = (text.match(/\n/g) ?? []).length + 1;
  const byteCount = Buffer.byteLength(text);

  if (lineCount <= opts.maxLines && byteCount <= opts.maxBytes) {
    return { content: text, truncated: false };
  }

  // Write full content to a temporary file
  const id = generateId();
  let outputPath: string;

  try {
    outputPath = writeToolOutputFile(getToolOutputDir(), id, text);
  } catch (err) {
    try {
      outputPath = writeToolOutputFile(getFallbackToolOutputDir(), id, text);
      logger.warn('Primary tool-output directory unavailable, wrote truncated output to temp storage instead', {
        id,
        byteCount,
        lineCount,
        error: err instanceof Error ? err.message : String(err),
        outputPath,
      });
    } catch (fallbackErr) {
      // If we can't write the file anywhere, return the truncated preview without a path
      // reference so the caller is not left with a useless error.
      logger.error('Failed to write truncated tool output to disk', fallbackErr instanceof Error ? fallbackErr : undefined, {
        id,
        byteCount,
        lineCount,
        primaryError: err instanceof Error ? err.message : String(err),
      });
      const preview = applyTruncation(text, opts);
      const hint = `\n\n[Output truncated. Could not save full output to disk. Preview shows ${opts.direction === 'head' ? 'first' : 'last'} portion of ${byteCount} bytes.]`;
      return { content: preview + hint, truncated: false };
    }
  }

  logger.debug('Tool output truncated and saved', {
    id,
    outputPath,
    originalLines: lineCount,
    originalBytes: byteCount,
    maxLines: opts.maxLines,
    maxBytes: opts.maxBytes,
    direction: opts.direction,
  });

  const preview = applyTruncation(text, opts);
  const hint =
    `\n\n[Output truncated. Full output (${byteCount} bytes) saved to ${outputPath}. ` +
    `Use Read tool with offset/limit to examine specific sections.]`;

  return { content: preview + hint, truncated: true, outputPath };
}

/**
 * Delete tool-output files older than `maxAgeMs` milliseconds (default 7 days).
 *
 * @returns The number of files successfully deleted.
 */
export async function cleanupOldOutputs(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
  const dir = path.join(getUserDataPath(), 'tool-output');

  if (!fs.existsSync(dir)) {
    return 0;
  }

  const now = Date.now();
  let deleted = 0;

  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch (err) {
    logger.warn('Could not read tool-output directory during cleanup', { dir, error: String(err) });
    return 0;
  }

  for (const entry of entries) {
    const filePath = path.join(dir, entry);
    try {
      const stat = await fs.promises.stat(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        await fs.promises.unlink(filePath);
        deleted++;
      }
    } catch (err) {
      // File may have already been removed by another process; skip silently
      logger.debug('Skipping file during cleanup', { filePath, error: String(err) });
    }
  }

  if (deleted > 0) {
    logger.info('Cleaned up old tool-output files', { deleted, maxAgeMs });
  }

  return deleted;
}

/**
 * Register an hourly interval that removes tool-output files older than 7 days.
 *
 * Call this once during application startup (e.g., in `main.ts`). The returned
 * handle can be passed to `clearInterval()` to stop cleanup on shutdown.
 *
 * @returns The interval handle (from `setInterval`).
 */
export function initTruncationCleanup(): NodeJS.Timeout {
  const ONE_HOUR_MS = 60 * 60 * 1000;

  const handle = setInterval(() => {
    cleanupOldOutputs().catch((err) => {
      logger.error('Truncation cleanup failed', err instanceof Error ? err : undefined);
    });
  }, ONE_HOUR_MS);

  // Allow the Node.js process to exit even if this timer is still pending
  if (handle.unref) {
    handle.unref();
  }

  logger.debug('Truncation cleanup scheduler initialised', { intervalMs: ONE_HOUR_MS });
  return handle;
}
