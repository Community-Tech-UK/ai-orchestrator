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

const INTERRUPTED_TOOL_RESULT = '[Tool execution interrupted — session recovered]';
const SYNTHETIC_ID_PREFIX = 'repair-';

function isToolCall(entry: ConversationEntry): boolean {
  return entry.role === 'assistant' && entry.toolUse != null && entry.toolUse.kind !== 'result';
}

/** A result this function fabricated on an earlier resume, persisted since. */
function isSyntheticToolResult(entry: ConversationEntry): boolean {
  return entry.role === 'tool'
    && entry.id.startsWith(SYNTHETIC_ID_PREFIX)
    && entry.content === INTERRUPTED_TOOL_RESULT;
}

/**
 * Whether the call at `index` received a result anywhere after it.
 *
 * Providers do not put the result immediately after its call: parallel calls
 * are emitted before their results, and ACP interleaves narration. A result
 * naming a call id answers only that call. An id-less result answers any call
 * earlier in the same turn — this can miss a genuine orphan in a parallel
 * batch, which is harmless, whereas the old "next entry must be a result" rule
 * fabricated an interruption for nearly every Copilot call.
 */
function hasToolResult(entries: readonly ConversationEntry[], index: number): boolean {
  const callId = entries[index].toolUse?.callId;
  let sameTurn = true;
  for (let j = index + 1; j < entries.length; j++) {
    const candidate = entries[j];
    if (candidate.role === 'user') {
      if (!callId) return false;
      sameTurn = false;
      continue;
    }
    if (candidate.role !== 'tool') continue;
    const resultFor = candidate.toolUse?.resultForCallId;
    if (resultFor ? resultFor === callId : sameTurn) return true;
  }
  return false;
}

export function validateTranscript(
  history: ConversationEntry[]
): TranscriptRepairResult {
  if (history.length === 0) {
    return { status: 'ok', entries: [], repairs: [] };
  }

  const repairs: string[] = [];

  // Earlier resumes persisted synthetic results, each directly after its call.
  // Strip them all, then re-decide: one whose call is still unanswered is kept
  // as-is, so a transcript validates identically on every later resume.
  const priorSyntheticByCallId = new Map<string, ConversationEntry>();
  const source: ConversationEntry[] = [];
  for (const entry of history) {
    if (isSyntheticToolResult(entry)) {
      const previous = source[source.length - 1];
      if (previous && isToolCall(previous)) priorSyntheticByCallId.set(previous.id, entry);
      continue;
    }
    source.push(entry);
  }
  const priorSyntheticCount = history.length - source.length;

  const entries: ConversationEntry[] = [];
  let keptSynthetic = 0;
  for (let i = 0; i < source.length; i++) {
    const entry = source[i];
    entries.push(entry);
    if (!isToolCall(entry) || hasToolResult(source, i)) continue;

    const prior = priorSyntheticByCallId.get(entry.id);
    if (prior) {
      entries.push(prior);
      keptSynthetic++;
      continue;
    }
    const toolUse = entry.toolUse!;
    entries.push({
      id: `${SYNTHETIC_ID_PREFIX}tool-result-${entry.id}`,
      role: 'tool',
      content: INTERRUPTED_TOOL_RESULT,
      timestamp: entry.timestamp + 1,
      toolUse: {
        kind: 'result',
        toolName: toolUse.toolName,
        input: toolUse.input,
        ...(toolUse.callId ? { resultForCallId: toolUse.callId } : {}),
        output: '[interrupted]',
      },
    });
    repairs.push(
      `Inserted synthetic tool_result for orphaned ${toolUse.toolName} at index ${i}`
    );
  }

  const staleSynthetic = priorSyntheticCount - keptSynthetic;
  if (staleSynthetic > 0) {
    repairs.push(`Removed ${staleSynthetic} stale synthetic tool results`);
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
