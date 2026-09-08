/**
 * Write-through archive for Codex command-output deltas.
 *
 * Codex's `tool_output_token_limit` truncates what the model retains. The
 * full streamed delta is still useful for operators, so AIO stores it under
 * userData with owner-only permissions and a 7-day TTL.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getLogger } from '../../../logging/logger';

const logger = getLogger('CodexCommandOutputArchive');

export const CODEX_COMMAND_OUTPUT_ARCHIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const COMMAND_OUTPUT_DELTA_METHODS = new Set([
  'item/commandExecution/outputDelta',
  'command/exec/outputDelta',
  'process/outputDelta',
]);

let archiveDirOverride: string | null = null;
let lastCleanupAt = 0;

export function setCodexCommandOutputArchiveDirForTesting(dir: string | null): void {
  archiveDirOverride = dir;
  lastCleanupAt = 0;
}

function getUserDataPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron');
    const userDataPath = app?.getPath?.('userData');
    if (typeof userDataPath === 'string' && userDataPath.length > 0) {
      return userDataPath;
    }
  } catch {
    // Electron not available (tests, headless)
  }
  return path.join(os.homedir(), '.orchestrator');
}

function getArchiveDir(): string {
  if (archiveDirOverride) {
    return archiveDirOverride;
  }
  return path.join(getUserDataPath(), 'codex-command-output');
}

function ensureArchiveDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function chmodOwnerOnly(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows and some test filesystems ignore POSIX modes.
  }
}

function readString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

function sanitizeId(value: string): string {
  return value.replace(/[^\w.-]/g, '_').slice(0, 80) || 'item';
}

function correlationId(threadId: string | null, itemId: string | null): string {
  const raw = `${threadId ?? 'unknown'}:${itemId ?? 'unknown'}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function extractDeltaText(params: Record<string, unknown>): string | null {
  const direct = readString(params, [
    'delta',
    'outputDelta',
    'output_delta',
    'chunk',
    'stdout',
    'text',
    'content',
    'output',
  ]);
  if (direct) return direct;
  const nested = params['delta'];
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return readString(nested as Record<string, unknown>, ['text', 'content', 'output', 'stdout']);
  }
  return null;
}

function extractCompletedCommandOutput(params: Record<string, unknown>): string | null {
  const item = params['item'];
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return null;
  }
  const record = item as Record<string, unknown>;
  const type = record['type'];
  if (type !== 'commandExecution' && type !== 'command_execution') {
    return null;
  }
  return readString(record, ['aggregatedOutput', 'aggregated_output']);
}

function archiveIds(params: Record<string, unknown>): { threadId: string | null; itemId: string | null } {
  const item = params['item'];
  const itemRecord = item && typeof item === 'object' && !Array.isArray(item)
    ? item as Record<string, unknown>
    : null;
  return {
    threadId: readString(params, ['threadId', 'thread_id']),
    itemId: readString(params, ['itemId', 'item_id'])
      ?? (itemRecord ? readString(itemRecord, ['id']) : null),
  };
}

function archiveFilePath(params: Record<string, unknown>): string {
  const { threadId, itemId } = archiveIds(params);
  return path.join(
    getArchiveDir(),
    `${correlationId(threadId, itemId)}-${sanitizeId(itemId ?? 'item')}.log`,
  );
}

function archiveAlreadyWritten(params: Record<string, unknown>): boolean {
  try {
    return fs.statSync(archiveFilePath(params)).size > 0;
  } catch {
    return false;
  }
}

function appendArchiveChunk(params: Record<string, unknown>, chunk: string): void {
  const dir = getArchiveDir();
  ensureArchiveDir(dir);
  const filePath = archiveFilePath(params);

  let existingBytes = 0;
  try {
    existingBytes = fs.statSync(filePath).size;
  } catch {
    existingBytes = 0;
  }
  if (existingBytes >= MAX_ARCHIVE_BYTES) {
    return;
  }

  const remaining = MAX_ARCHIVE_BYTES - existingBytes;
  const payload = Buffer.byteLength(chunk) > remaining
    ? `${chunk.slice(0, Math.max(0, remaining - 32))}\n[truncated]\n`
    : chunk;
  const flags = existingBytes > 0 ? 'a' : 'w';
  const fd = fs.openSync(filePath, flags, 0o600);
  try {
    fs.writeSync(fd, payload);
  } finally {
    fs.closeSync(fd);
  }
  chmodOwnerOnly(filePath);
  maybeCleanupExpiredArchives();
}

function maybeCleanupExpiredArchives(): void {
  const now = Date.now();
  if (now - lastCleanupAt < 60 * 60 * 1000) {
    return;
  }
  lastCleanupAt = now;
  void cleanupExpiredCodexCommandOutputArchives().catch((error) => {
    logger.debug('Codex command-output archive cleanup failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export function archiveCodexCommandOutputNotification(
  notification: { method: string; params?: Record<string, unknown> | null },
): void {
  try {
    const params = notification.params;
    if (!params || typeof params !== 'object') {
      return;
    }
    const record = params as Record<string, unknown>;
    if (COMMAND_OUTPUT_DELTA_METHODS.has(notification.method)) {
      const delta = extractDeltaText(record);
      if (delta) {
        appendArchiveChunk(record, delta);
      }
      return;
    }
    if (notification.method === 'item/completed') {
      if (archiveAlreadyWritten(record)) {
        return;
      }
      const output = extractCompletedCommandOutput(record);
      if (output) {
        appendArchiveChunk(record, output);
      }
    }
  } catch (error) {
    logger.debug('Codex command-output archive write skipped', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function cleanupExpiredCodexCommandOutputArchives(
  maxAgeMs = CODEX_COMMAND_OUTPUT_ARCHIVE_TTL_MS,
): Promise<number> {
  const dir = getArchiveDir();
  if (!fs.existsSync(dir)) {
    return 0;
  }
  const now = Date.now();
  let deleted = 0;
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const filePath = path.join(dir, entry);
    try {
      const stat = await fs.promises.stat(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        await fs.promises.unlink(filePath);
        deleted += 1;
      }
    } catch {
      // Concurrent cleanup or already removed.
    }
  }
  return deleted;
}

export function initCodexCommandOutputArchiveCleanup(): NodeJS.Timeout {
  const handle = setInterval(() => {
    cleanupExpiredCodexCommandOutputArchives().catch((error) => {
      logger.debug('Codex command-output archive cleanup failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 60 * 60 * 1000);
  handle.unref();
  return handle;
}
