import { createHash } from 'node:crypto';
import type { ConversationEntry } from './session-continuity.types';

const RECOVERY_FINGERPRINT_TIMESTAMP_BUCKET_MS = 5_000;

export interface ReconciledRecoveryTranscript {
  messages: ConversationEntry[];
  archivedCount: number;
  recoveredCount: number;
  droppedDuplicates: number;
  coverageEnd?: number;
}

function normalizeText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .trim();
}

function stableValue(value: unknown): unknown {
  if (typeof value === 'string') return normalizeText(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value === undefined) return '[undefined]';
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return String(value);
}

function recoveryFingerprint(entry: ConversationEntry): string {
  const timestampBucket = Math.floor(
    entry.timestamp / RECOVERY_FINGERPRINT_TIMESTAMP_BUCKET_MS,
  );
  const identity = {
    role: entry.role.trim().toLowerCase(),
    content: normalizeText(entry.content),
    timestampBucket,
    toolUse: entry.toolUse
      ? {
          toolName: normalizeText(entry.toolUse.toolName).toLowerCase(),
          kind: entry.toolUse.kind ?? null,
          callId: entry.toolUse.callId ?? null,
          resultForCallId: entry.toolUse.resultForCallId ?? null,
          isError: entry.toolUse.isError ?? null,
          input: stableValue(entry.toolUse.input),
          output: entry.toolUse.output === undefined
            ? '[undefined]'
            : normalizeText(entry.toolUse.output),
        }
      : null,
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function timestampOf(entry: ConversationEntry): number {
  return Number.isFinite(entry.timestamp) ? entry.timestamp : 0;
}

export function reconcileRecoveryTranscript(
  archived: readonly ConversationEntry[],
  continuity: readonly ConversationEntry[],
): ReconciledRecoveryTranscript {
  const messages = [...archived];
  const ids = new Set(archived.map((entry) => entry.id));
  const continuityIds = new Set<string>();
  const archivedFingerprintCounts = new Map<string, number>();
  const archivedFingerprintsById = new Map<string, string>();
  for (const entry of archived) {
    const fingerprint = recoveryFingerprint(entry);
    archivedFingerprintsById.set(entry.id, fingerprint);
    archivedFingerprintCounts.set(
      fingerprint,
      (archivedFingerprintCounts.get(fingerprint) ?? 0) + 1,
    );
  }
  const coverageEnd = archived.length > 0
    ? archived.reduce((latest, entry) => Math.max(latest, timestampOf(entry)), 0)
    : undefined;
  let recoveredCount = 0;
  let droppedDuplicates = 0;

  const orderedContinuity = continuity
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) =>
      timestampOf(left.entry) - timestampOf(right.entry)
      || left.index - right.index);

  for (const { entry } of orderedContinuity) {
    const fingerprint = recoveryFingerprint(entry);
    const remainingArchivedCopies = archivedFingerprintCounts.get(fingerprint) ?? 0;
    if (continuityIds.has(entry.id)) {
      droppedDuplicates += 1;
      continue;
    }
    continuityIds.add(entry.id);
    if (ids.has(entry.id)) {
      const archivedFingerprint = archivedFingerprintsById.get(entry.id);
      const archivedCopies = archivedFingerprint === undefined
        ? 0
        : archivedFingerprintCounts.get(archivedFingerprint) ?? 0;
      if (archivedFingerprint !== undefined && archivedCopies > 1) {
        archivedFingerprintCounts.set(archivedFingerprint, archivedCopies - 1);
      } else if (archivedFingerprint !== undefined && archivedCopies === 1) {
        archivedFingerprintCounts.delete(archivedFingerprint);
      }
      droppedDuplicates += 1;
      continue;
    }
    ids.add(entry.id);
    if (remainingArchivedCopies > 1) {
      archivedFingerprintCounts.set(fingerprint, remainingArchivedCopies - 1);
      droppedDuplicates += 1;
      continue;
    }
    if (remainingArchivedCopies === 1) {
      archivedFingerprintCounts.delete(fingerprint);
      droppedDuplicates += 1;
      continue;
    }
    if (coverageEnd !== undefined && timestampOf(entry) < coverageEnd) continue;
    messages.push(entry);
    recoveredCount += 1;
  }

  return {
    messages,
    archivedCount: archived.length,
    recoveredCount,
    droppedDuplicates,
    ...(coverageEnd === undefined ? {} : { coverageEnd }),
  };
}
