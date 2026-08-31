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
import type { SessionSnapshot, SessionState } from './session-continuity.types';
import type { ContinuityRecoveryMetadata } from './session-recovery-candidate-service';
import { readContinuityPayloadHandleReadOnly } from './continuity-recovery-metadata';
import { cleanupOrphanedTmpFiles, type TmpCleanupResult } from './orphaned-tmp-cleanup';

export { cleanupOrphanedTmpFiles };
export type {
  TmpCleanupFileOperations,
  TmpCleanupResult,
  TmpPromotionValidation,
  TmpPromotionValidator,
} from './orphaned-tmp-cleanup';

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

export interface ContinuityTmpCleanupResult {
  states: TmpCleanupResult;
  snapshots: TmpCleanupResult;
  recoveryMetadata: TmpCleanupResult;
}

export interface ContinuityTmpCleanupOptions {
  stateDir: string;
  snapshotDir: string;
  recoveryMetadataDir: string;
  readPayload?: (handle: fs.promises.FileHandle) => Promise<unknown>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isCompleteConversationEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value['id'] === 'string'
    && ['user', 'assistant', 'system', 'tool'].includes(String(value['role']))
    && typeof value['content'] === 'string'
    && isFiniteNumber(value['timestamp']);
}

function isCompleteSessionState(value: unknown, expectedInstanceId: string): value is SessionState {
  if (!isRecord(value) || value['instanceId'] !== expectedInstanceId) return false;
  const contextUsage = value['contextUsage'];
  return typeof value['displayName'] === 'string'
    && typeof value['agentId'] === 'string'
    && typeof value['modelId'] === 'string'
    && typeof value['workingDirectory'] === 'string'
    && Array.isArray(value['conversationHistory'])
    && value['conversationHistory'].every(isCompleteConversationEntry)
    && isRecord(contextUsage)
    && isFiniteNumber(contextUsage['used'])
    && isFiniteNumber(contextUsage['total'])
    && Array.isArray(value['pendingTasks'])
    && isRecord(value['environmentVariables'])
    && Array.isArray(value['activeFiles'])
    && Array.isArray(value['skillsLoaded'])
    && Array.isArray(value['hooksActive']);
}

function isCompleteSessionSnapshot(value: unknown, expectedSnapshotId: string): value is SessionSnapshot {
  if (!isRecord(value) || value['id'] !== expectedSnapshotId || !isFiniteNumber(value['timestamp'])) {
    return false;
  }
  const state = value['state'];
  const instanceId = typeof value['instanceId'] === 'string'
    ? value['instanceId']
    : isRecord(state) && typeof state['instanceId'] === 'string' ? state['instanceId'] : null;
  const metadata = value['metadata'];
  return instanceId !== null
    && isCompleteSessionState(state, instanceId)
    && isRecord(metadata)
    && isFiniteNumber(metadata['messageCount'])
    && isFiniteNumber(metadata['tokensUsed'])
    && isFiniteNumber(metadata['duration'])
    && ['auto', 'manual', 'checkpoint'].includes(String(metadata['trigger']));
}

function isCurrentRecoveryMetadata(
  value: unknown,
  expectedInstanceId: string,
  stateStat: fs.Stats,
): value is ContinuityRecoveryMetadata {
  if (!isRecord(value) || value['sourceInstanceId'] !== expectedInstanceId) return false;
  const generation = value['stateFileGeneration'];
  return typeof value['recoveryKey'] === 'string'
    && typeof value['provider'] === 'string'
    && isFiniteNumber(value['lastActivityAt'])
    && isFiniteNumber(value['modifiedAt'])
    && isFiniteNumber(value['messageCount'])
    && typeof value['hasUserPrompt'] === 'boolean'
    && typeof value['hasAssistantOutput'] === 'boolean'
    && typeof value['nativeResumeAvailable'] === 'boolean'
    && isRecord(generation)
    && generation['size'] === stateStat.size
    && generation['mtimeMs'] === stateStat.mtimeMs
    && generation['ctimeMs'] === stateStat.ctimeMs
    && generation['ino'] === stateStat.ino;
}

function isSameStateGeneration(left: fs.Stats, right: fs.Stats): boolean {
  return left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.ino === right.ino;
}

function fileId(finalPath: string): string {
  return path.basename(finalPath, '.json');
}

export async function cleanupContinuityOrphanedTmpFiles(
  options: ContinuityTmpCleanupOptions,
): Promise<ContinuityTmpCleanupResult> {
  const readPayload = options.readPayload ?? readContinuityPayloadHandleReadOnly;
  const [states, snapshots] = await Promise.all([
    cleanupOrphanedTmpFiles(options.stateDir, async (_claimedPath, finalPath, handle) =>
      isCompleteSessionState(
        await readPayload(handle),
        fileId(finalPath),
      )),
    cleanupOrphanedTmpFiles(options.snapshotDir, async (_claimedPath, finalPath, handle) =>
      isCompleteSessionSnapshot(
        await readPayload(handle),
        fileId(finalPath),
      )),
  ]);
  const recoveryMetadata = await cleanupOrphanedTmpFiles(
    options.recoveryMetadataDir,
    async (_claimedPath, finalPath, handle) => {
      const instanceId = fileId(finalPath);
      const statePath = path.join(options.stateDir, `${instanceId}.json`);
      const beforeRead = await fs.promises.stat(statePath)
        .catch(() => null);
      if (!beforeRead) return false;
      const metadata = await readPayload(handle);
      const afterRead = await fs.promises.stat(statePath).catch(() => null);
      if (!afterRead
        || !isSameStateGeneration(beforeRead, afterRead)
        || !isCurrentRecoveryMetadata(metadata, instanceId, afterRead)) return false;
      return {
        valid: true,
        canPromote: (): boolean => {
          try {
            return isSameStateGeneration(afterRead, fs.statSync(statePath));
          } catch {
            return false;
          }
        },
      };
    },
  );
  return { states, snapshots, recoveryMetadata };
}
