/**
 * Session Repair Service — Multi-layer session data validation and recovery.
 *
 * Layer 1: File-level validation & recovery (repairFile)
 * Layer 2: Transcript-level validation (validateTranscript)
 * Layer 3: Orphaned tmp file cleanup (cleanupOrphanedTmpFiles)
 */

import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../logging/logger';
import type { ConversationEntry } from './session-continuity';

const logger = getLogger('SessionRepair');

export interface RepairResult {
  status: 'ok' | 'repaired' | 'quarantined' | 'unrecoverable';
  repairs: string[];
  quarantinedPath?: string;
}

export interface TranscriptRepairResult {
  status: 'ok' | 'repaired';
  entries: ConversationEntry[];
  repairs: string[];
}

export interface TmpCleanupResult {
  recovered: string[];
  deleted: string[];
  failed: string[];
}

export function validateTranscript(
  history: ConversationEntry[]
): TranscriptRepairResult {
  if (history.length === 0) {
    return { status: 'ok', entries: [], repairs: [] };
  }

  const repairs: string[] = [];
  const entries = [...history];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.toolUse && entry.role === 'assistant') {
      const next = entries[i + 1];
      if (!next || next.role !== 'tool') {
        const synthetic: ConversationEntry = {
          id: `repair-${Date.now()}-${i}`,
          role: 'tool',
          content: '[Tool execution interrupted — session recovered]',
          timestamp: entry.timestamp + 1,
          toolUse: {
            toolName: entry.toolUse.toolName,
            input: entry.toolUse.input,
            output: '[interrupted]',
          },
        };
        entries.splice(i + 1, 0, synthetic);
        repairs.push(
          `Inserted synthetic tool_result for orphaned ${entry.toolUse.toolName} at index ${i}`
        );
      }
    }
  }

  const beforeCount = entries.length;
  const filtered = entries.filter(
    (e) => e.content.length > 0 || e.toolUse != null
  );
  if (filtered.length < beforeCount) {
    repairs.push(`Removed ${beforeCount - filtered.length} empty entries`);
  }

  for (let i = 1; i < filtered.length; i++) {
    if (filtered[i].timestamp < filtered[i - 1].timestamp) {
      repairs.push(
        `Warning: Non-monotonic timestamp at index ${i} ` +
          `(${filtered[i].timestamp} < ${filtered[i - 1].timestamp})`
      );
    }
  }

  if (repairs.length > 0) {
    logger.info('Transcript repaired', { repairCount: repairs.length, repairs });
  }

  return {
    status: repairs.length > 0 ? 'repaired' : 'ok',
    entries: filtered,
    repairs,
  };
}

// ---------------------------------------------------------------------------
// Layer 1: File-level repair
// ---------------------------------------------------------------------------

/** Move a corrupt file to the quarantine directory with a timestamped .corrupt extension. */
export function quarantineFile(filePath: string, quarantineDir: string): string {
  const basename = path.basename(filePath);
  const dest = path.join(quarantineDir, `${basename}.${Date.now()}.corrupt`);
  fs.renameSync(filePath, dest);
  logger.warn('File quarantined', { original: filePath, dest });
  return dest;
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function truncateAfterCompleteRoot(raw: string): string | null {
  let inString = false;
  let escaping = false;
  const stack: string[] = [];
  let lastCompleteIndex: number | null = null;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === '\\') {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }

    if (char === '}' || char === ']') {
      const expectedOpen = char === '}' ? '{' : '[';
      if (stack.pop() !== expectedOpen) {
        return null;
      }
      if (stack.length === 0) {
        lastCompleteIndex = i + 1;
      }
    }
  }

  if (lastCompleteIndex === null || lastCompleteIndex >= raw.length) {
    return null;
  }

  return raw.slice(0, lastCompleteIndex).trimEnd();
}

function balanceTruncatedJson(raw: string): string | null {
  let inString = false;
  let escaping = false;
  const stack: string[] = [];

  for (const char of raw) {
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === '\\') {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }

    if (char === '}' || char === ']') {
      const expectedOpen = char === '}' ? '{' : '[';
      if (stack.pop() !== expectedOpen) {
        return null;
      }
    }
  }

  if (!inString && stack.length === 0) {
    return null;
  }

  let repaired = raw;
  if (inString) {
    repaired += '"';
  }

  for (let i = stack.length - 1; i >= 0; i--) {
    repaired += stack[i] === '{' ? '}' : ']';
  }

  return repaired;
}

function tryRecoverJson(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const candidates = [
    truncateAfterCompleteRoot(trimmed),
    balanceTruncatedJson(trimmed),
  ];

  for (const candidate of candidates) {
    if (!candidate || candidate === trimmed) {
      continue;
    }

    if (parseJson(candidate) !== null) {
      return candidate;
    }
  }

  return null;
}

function writeRepairedFile(
  filePath: string,
  raw: string,
  repairs: string[],
): RepairResult {
  fs.writeFileSync(filePath, raw, 'utf8');
  logger.info('File repaired', { filePath, repairs });
  return { status: 'repaired', repairs };
}

/**
 * Inspect a single JSON file and quarantine it if it cannot be parsed.
 *
 * Expected envelope format: `{ encrypted: boolean, data: string }`.
 * If the envelope is valid but the inner `data` string is not parseable JSON,
 * the file is still considered corrupt and is quarantined.
 */
export function repairFile(filePath: string, quarantineDir: string): RepairResult {
  const repairs: string[] = [];

  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    logger.error('Cannot read file for repair', err as Error, { filePath });
    return { status: 'unrecoverable', repairs: ['Cannot read file'] };
  }

  let repairedRaw = raw;
  let payload = parseJson<unknown>(repairedRaw);
  if (payload === null) {
    const recoveredOuter = tryRecoverJson(repairedRaw);
    if (recoveredOuter === null) {
      repairs.push('Outer JSON parse failed');
      try {
        const quarantinedPath = quarantineFile(filePath, quarantineDir);
        return { status: 'quarantined', repairs, quarantinedPath };
      } catch (err) {
        logger.error('Failed to quarantine file', err as Error, { filePath });
        return { status: 'unrecoverable', repairs };
      }
    }

    repairedRaw = recoveredOuter;
    payload = parseJson<unknown>(repairedRaw);
    repairs.push('Recovered truncated outer JSON');
  }

  // Validate envelope shape and inner data.
  if (payload !== null && typeof payload === 'object' && 'data' in (payload as object)) {
    const envelopeObj = payload as { encrypted?: unknown; data: unknown };

    if (envelopeObj.encrypted === true && typeof envelopeObj.data === 'string') {
      return repairs.length > 0
        ? writeRepairedFile(filePath, JSON.stringify(envelopeObj), repairs)
        : { status: 'ok', repairs };
    }

    if (envelopeObj.encrypted === false && typeof envelopeObj.data === 'string') {
      if (parseJson(envelopeObj.data) === null) {
        const recoveredInner = tryRecoverJson(envelopeObj.data);
        if (recoveredInner === null) {
          repairs.push('Inner data JSON parse failed');
          try {
            const quarantinedPath = quarantineFile(filePath, quarantineDir);
            return { status: 'quarantined', repairs, quarantinedPath };
          } catch (err) {
            logger.error('Failed to quarantine file', err as Error, { filePath });
            return { status: 'unrecoverable', repairs };
          }
        }

        envelopeObj.data = recoveredInner;
        repairs.push('Recovered truncated inner data JSON');
      }

      return repairs.length > 0
        ? writeRepairedFile(filePath, JSON.stringify(envelopeObj), repairs)
        : { status: 'ok', repairs };
    }

    repairs.push('Malformed continuity envelope');
    try {
      const quarantinedPath = quarantineFile(filePath, quarantineDir);
      return { status: 'quarantined', repairs, quarantinedPath };
    } catch (err) {
      logger.error('Failed to quarantine file', err as Error, { filePath });
      return { status: 'unrecoverable', repairs };
    }
  }

  return repairs.length > 0
    ? writeRepairedFile(filePath, JSON.stringify(payload), repairs)
    : { status: 'ok', repairs };
}

// ---------------------------------------------------------------------------
// Layer 3: Orphaned tmp file cleanup
// ---------------------------------------------------------------------------

/**
 * Scan a directory for `*.json.tmp` files and resolve each one:
 * - If the corresponding `.json` exists → delete the `.tmp` (stale write artifact).
 * - If the corresponding `.json` is missing → promote `.tmp` to `.json` (crash recovery).
 */
export async function cleanupOrphanedTmpFiles(dir: string): Promise<TmpCleanupResult> {
  const result: TmpCleanupResult = { recovered: [], deleted: [], failed: [] };

  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch (err) {
    logger.error('Cannot read directory for tmp cleanup', err as Error, { dir });
    return result;
  }

  const tmpFiles = entries.filter((f) => f.endsWith('.json.tmp'));

  for (const tmpFile of tmpFiles) {
    const tmpPath = path.join(dir, tmpFile);
    const jsonFile = tmpFile.slice(0, -4); // strip '.tmp'
    const jsonPath = path.join(dir, jsonFile);

    const jsonExists = entries.includes(jsonFile);

    if (jsonExists) {
      // Committed write succeeded — the .tmp is stale, delete it.
      try {
        await fs.promises.unlink(tmpPath);
        result.deleted.push(tmpPath);
        logger.info('Deleted stale tmp file', { tmpPath });
      } catch (err) {
        logger.error('Failed to delete tmp file', err as Error, { tmpPath });
        result.failed.push(tmpPath);
      }
    } else {
      // Crash during atomic rename — promote tmp to json.
      try {
        await fs.promises.rename(tmpPath, jsonPath);
        result.recovered.push(jsonPath);
        logger.info('Recovered orphaned tmp file', { tmpPath, jsonPath });
      } catch (err) {
        logger.error('Failed to recover tmp file', err as Error, { tmpPath });
        result.failed.push(tmpPath);
      }
    }
  }

  return result;
}
