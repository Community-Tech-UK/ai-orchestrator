import * as fs from 'fs';
import * as path from 'path';
import type { FileHandle } from 'fs/promises';
import { z } from 'zod';
import {
  DisplayNameSchema,
  InstanceIdSchema,
  ModelIdSchema,
  SessionIdSchema,
  WorkingDirectorySchema,
} from '@contracts/schemas/common';
import { SessionRecoveryProviderSchema } from '@contracts/schemas/session';
import { withLock } from '../util/file-lock';
import { getCanonicalRecoveryKey, type RecoverableSessionSelectionInput } from './recoverable-session-selection';
import type {
  ContinuityRecoveryMetadata,
  ContinuityStateFileGeneration,
} from './session-recovery-candidate-service';
import type { SessionState } from './session-continuity.types';
import { getSafeStorage } from './safe-storage-accessor';
import { getContinuityStagingPath } from './continuity-staging-file';

export const MAX_LEGACY_RECOVERY_STATE_READS = 50;

const NonNegativeIntegerSchema = z.number().int().nonnegative();
const StateFileGenerationSchema = z.object({
  size: NonNegativeIntegerSchema,
  mtimeMs: z.number().finite().nonnegative(),
  ctimeMs: z.number().finite().nonnegative(),
  ino: NonNegativeIntegerSchema,
});
const ContinuityRecoveryMetadataSchema = z.object({
  recoveryKey: z.string().min(1).max(500),
  sourceInstanceId: InstanceIdSchema,
  historyThreadId: z.string().min(1).max(200).optional(),
  sessionId: SessionIdSchema.optional(),
  provider: SessionRecoveryProviderSchema,
  modelId: ModelIdSchema.optional(),
  displayName: DisplayNameSchema.optional(),
  workingDirectory: WorkingDirectorySchema.optional(),
  lastActivityAt: NonNegativeIntegerSchema,
  modifiedAt: NonNegativeIntegerSchema,
  messageCount: NonNegativeIntegerSchema,
  hasUserPrompt: z.boolean(),
  hasAssistantOutput: z.boolean(),
  nativeResumeAvailable: z.boolean(),
  stateFileGeneration: StateFileGenerationSchema.optional(),
});

export class ContinuityWriteEpochs {
  private readonly epochs = new Map<string, number>();

  capture(instanceId: string): number {
    return this.epochs.get(instanceId) ?? 0;
  }

  advance(instanceId: string): void {
    this.epochs.set(instanceId, this.capture(instanceId) + 1);
  }

  isCurrent(instanceId: string, epoch: number): boolean {
    return this.capture(instanceId) === epoch;
  }
}

export function getLastConversationTimestamp(state: SessionState): number {
  return state.conversationHistory.reduce(
    (newest, entry) => Math.max(newest, typeof entry.timestamp === 'number' ? entry.timestamp : 0),
    0,
  );
}

export function getStateRecoveryMetadata(
  state: SessionState,
  dehydrated: boolean,
  cached?: { messageCount: number; hasAssistantOutput: boolean },
): { messageCount: number; hasAssistantOutput: boolean } {
  if (state.conversationHistory.length === 0 && dehydrated) {
    return cached ?? { messageCount: 0, hasAssistantOutput: false };
  }
  return {
    messageCount: state.conversationHistory.length,
    hasAssistantOutput: state.conversationHistory.some((entry) => entry.role === 'assistant'),
  };
}

export function buildContinuityRecoveryMetadata(
  state: SessionState,
  modifiedAt: number,
): ContinuityRecoveryMetadata {
  const provider = state.provider ?? 'claude';
  return {
    recoveryKey: getCanonicalRecoveryKey({
      instanceId: state.instanceId, provider, historyThreadId: state.historyThreadId,
      resumeCursor: state.resumeCursor, sessionId: state.sessionId,
    }),
    sourceInstanceId: state.instanceId,
    historyThreadId: state.historyThreadId,
    sessionId: state.sessionId,
    provider,
    modelId: state.modelId,
    displayName: state.displayName,
    workingDirectory: state.workingDirectory,
    lastActivityAt: Math.max(state.lastWriteTimestamp ?? 0, getLastConversationTimestamp(state)),
    modifiedAt: Math.max(0, Math.floor(modifiedAt)),
    messageCount: state.conversationHistory.length,
    hasUserPrompt: state.conversationHistory.some((entry) => entry.role === 'user'),
    hasAssistantOutput: state.conversationHistory.some((entry) => entry.role === 'assistant'),
    nativeResumeAvailable: Boolean(state.sessionId || state.resumeCursor),
  };
}

function getStateFileGeneration(stat: fs.Stats): ContinuityStateFileGeneration {
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino };
}

export function buildBoundContinuityRecoveryMetadata(
  state: SessionState,
  stat: fs.Stats,
): ContinuityRecoveryMetadata {
  return {
    ...buildContinuityRecoveryMetadata(state, stat.mtimeMs),
    stateFileGeneration: getStateFileGeneration(stat),
  };
}

function stateFileGenerationMatches(
  generation: ContinuityStateFileGeneration | undefined,
  stat: fs.Stats,
): boolean {
  if (!generation) return false;
  const current = getStateFileGeneration(stat);
  return generation.size === current.size
    && generation.mtimeMs === current.mtimeMs
    && generation.ctimeMs === current.ctimeMs
    && generation.ino === current.ino;
}

function fsyncParentDirectory(filePath: string): void {
  try {
    const dirFd = fs.openSync(path.dirname(filePath), 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch { /* directory fsync is unavailable on some platforms */ }
}

export async function writeContinuityPayloadAsyncAtomic(
  filePath: string,
  serialized: string,
  canCommit: () => boolean = () => true,
): Promise<boolean> {
  const tmpFile = getContinuityStagingPath(filePath);
  let committed = false;
  try {
    return await withLock(`${filePath}.lock`, async () => {
      const fh = await fs.promises.open(tmpFile, 'w');
      try {
        await fh.writeFile(serialized);
        await fh.sync();
      } finally {
        await fh.close();
      }
      if (!canCommit()) return false;
      fs.renameSync(tmpFile, filePath);
      committed = true;
      fsyncParentDirectory(filePath);
      return true;
    }, { purpose: `snapshot-${path.basename(filePath, '.json')}` });
  } finally {
    if (!committed) await fs.promises.unlink(tmpFile).catch(() => undefined);
  }
}

export function writeContinuityPayloadSyncAtomic(filePath: string, serialized: string): void {
  const tmpFile = getContinuityStagingPath(filePath);
  try {
    fs.writeFileSync(tmpFile, serialized);
    const fd = fs.openSync(tmpFile, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmpFile, filePath);
    fsyncParentDirectory(filePath);
  } catch (error) {
    try { fs.unlinkSync(tmpFile); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

function decodeContinuityPayload<T>(raw: string): T | null {
  try {
    let parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed?.['encrypted'] === true && typeof parsed['data'] === 'string') {
      const decrypted = getSafeStorage().decryptString(Buffer.from(parsed['data'], 'base64'));
      return JSON.parse(decrypted) as T;
    }
    if (parsed?.['encrypted'] === false && typeof parsed['data'] === 'string') {
      parsed = JSON.parse(parsed['data']) as Record<string, unknown>;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

export async function readContinuityPayloadReadOnly<T>(filePath: string): Promise<T | null> {
  try {
    return decodeContinuityPayload<T>(await fs.promises.readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export async function readContinuityPayloadHandleReadOnly<T>(handle: FileHandle): Promise<T | null> {
  try {
    return decodeContinuityPayload<T>(await handle.readFile({ encoding: 'utf-8' }));
  } catch {
    return null;
  }
}

export async function enumerateContinuityRecoveryMetadata(options: {
  stateDir: string;
  metadataDir: string;
  modifiedSince: number;
  preferredInstanceIds: readonly string[];
  normalizeState: (state: SessionState) => SessionState;
  readMetadataPayload?: (
    filePath: string,
  ) => Promise<ContinuityRecoveryMetadata | null>;
}): Promise<{ records: ContinuityRecoveryMetadata[]; skippedCorrupt: number }> {
  const records: ContinuityRecoveryMetadata[] = [];
  const indexedFiles = new Set<string>();
  let skippedCorrupt = 0;

  const stateFileNames = await fs.promises.readdir(options.stateDir).catch(() => [] as string[]);
  const stateFiles = (await Promise.all(stateFileNames.filter((file) => file.endsWith('.json'))
    .map(async (file) => ({
      file,
      stat: await fs.promises.stat(path.join(options.stateDir, file)).catch(() => null),
    }))))
    .filter((item): item is { file: string; stat: fs.Stats } => item.stat !== null);
  const stateFilesByName = new Map(stateFiles.map((item) => [item.file, item]));
  const metadataFiles = await fs.promises.readdir(options.metadataDir).catch(() => [] as string[]);
  for (const file of metadataFiles) {
    if (!file.endsWith('.json')) continue;
    const stateFile = stateFilesByName.get(file);
    if (!stateFile || stateFile.stat.mtimeMs < options.modifiedSince) continue;
    const beforeRead = stateFile.stat;
    const metadataPayload = await (options.readMetadataPayload
      ?? readContinuityPayloadReadOnly<ContinuityRecoveryMetadata>)(
      path.join(options.metadataDir, file),
    );
    const afterRead = await fs.promises.stat(path.join(options.stateDir, file)).catch(() => null);
    if (!afterRead) continue;
    stateFile.stat = afterRead;
    const metadata = parseContinuityRecoveryMetadata(metadataPayload);
    if (!metadata) {
      skippedCorrupt += 1;
      continue;
    }
    if (metadata.sourceInstanceId !== path.basename(file, '.json')
      || !stateFileGenerationMatches(getStateFileGeneration(beforeRead), afterRead)
      || !stateFileGenerationMatches(metadata.stateFileGeneration, afterRead)) continue;
    indexedFiles.add(file);
    records.push(metadata);
  }

  const preferred = new Set(options.preferredInstanceIds);
  const legacyFiles = stateFiles
    .filter((item) => item.stat.mtimeMs >= options.modifiedSince && !indexedFiles.has(item.file))
    .sort((left, right) =>
      Number(preferred.has(path.basename(right.file, '.json')))
      - Number(preferred.has(path.basename(left.file, '.json')))
      || right.stat.mtimeMs - left.stat.mtimeMs
      || left.file.localeCompare(right.file))
    .slice(0, MAX_LEGACY_RECOVERY_STATE_READS);

  for (const { file, stat } of legacyFiles) {
    try {
      const rawState = await readContinuityPayloadReadOnly<SessionState>(path.join(options.stateDir, file));
      if (!rawState?.instanceId || !Array.isArray(rawState.conversationHistory)) throw new Error('invalid');
      const state = options.normalizeState(rawState);
      const metadata = parseContinuityRecoveryMetadata(
        buildContinuityRecoveryMetadata(state, stat.mtimeMs),
      );
      if (!metadata) throw new Error('invalid');
      records.push(metadata);
    } catch {
      skippedCorrupt += 1;
    }
  }
  records.sort((left, right) =>
    right.lastActivityAt - left.lastActivityAt
    || left.sourceInstanceId.localeCompare(right.sourceInstanceId));
  return { records, skippedCorrupt };
}

function parseContinuityRecoveryMetadata(value: unknown): ContinuityRecoveryMetadata | null {
  const parsed = ContinuityRecoveryMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data as ContinuityRecoveryMetadata : null;
}

export function buildRecoverableSessionList(options: {
  states: readonly SessionState[];
  now: number;
  getActivity: (state: SessionState) => number;
  getMetadata: (state: SessionState) => { messageCount: number; hasAssistantOutput: boolean };
  isLive: (instanceId: string) => boolean;
}): RecoverableSessionSelectionInput[] {
  return options.states.map((state) => {
    const recoveryMetadata = options.getMetadata(state);
    return {
      instanceId: state.instanceId, sessionId: state.sessionId,
      historyThreadId: state.historyThreadId, resumeCursor: state.resumeCursor,
      provider: state.provider, modelId: state.modelId, displayName: state.displayName,
      workingDirectory: state.workingDirectory, capturedAt: options.now,
      recoveryKey: getCanonicalRecoveryKey({
        instanceId: state.instanceId, provider: state.provider,
        historyThreadId: state.historyThreadId, resumeCursor: state.resumeCursor,
        sessionId: state.sessionId,
      }),
      lastActivityAt: options.getActivity(state),
      isLive: options.isLive(state.instanceId),
      messageCount: recoveryMetadata.messageCount,
      hasAssistantOutput: recoveryMetadata.hasAssistantOutput,
    };
  });
}
