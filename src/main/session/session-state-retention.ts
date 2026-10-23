import * as path from 'path';
import { listStorageFiles, mapStorageFiles, removeStorageFiles, type StorageFile } from '../storage/storage-files';
import { readContinuityPayloadReadOnly } from './continuity-recovery-metadata';
import type { SessionState } from './session-continuity.types';
import { MAX_SESSION_STATE_FILE_BYTES } from './session-state-size-limit';

export interface SessionStateHistoryIdentity { originalInstanceId?: string; historyThreadId?: string; sessionId?: string }
interface SavedStateIdentity {
  sourceInstanceId?: string; instanceId?: string; historyThreadId?: string; sessionId?: string;
  stateFileGeneration?: { size: number; mtimeMs: number; ctimeMs: number; ino: number };
}

export function sessionStateHistoryIds(history: readonly SessionStateHistoryIdentity[]): Set<string> {
  return new Set(history.flatMap(entry => [entry.originalInstanceId, entry.historyThreadId, entry.sessionId].filter((id): id is string => !!id)));
}

export async function sessionStateIsAbsentFromHistory(file: StorageFile, sidecar: StorageFile | undefined, historyIds: ReadonlySet<string>): Promise<boolean> {
  const instanceId = path.basename(file.path, '.json');
  if (historyIds.has(instanceId)) return false;
  if (historyIds.size === 0) return true;
  let identity: SavedStateIdentity | null = null;
  if (sidecar && sidecar.bytes < 64 * 1024) {
    const data = await readContinuityPayloadReadOnly<SavedStateIdentity>(sidecar.path);
    const generation = data?.stateFileGeneration;
    if (data?.sourceInstanceId === instanceId && generation?.size === file.bytes && generation.mtimeMs === file.modifiedAt
      && generation.ctimeMs === file.changedAt && generation.ino === file.inode) identity = data;
  }
  if (!identity && file.bytes <= MAX_SESSION_STATE_FILE_BYTES) identity = await readContinuityPayloadReadOnly<SessionState>(file.path);
  // Unknown or oversized legacy records stay: absence from history is not
  // proven by a missing/stale sidecar or an unreadable state payload.
  if (!identity || (identity.instanceId ?? identity.sourceInstanceId) !== instanceId) return false;
  return ![identity.historyThreadId, identity.sessionId].some(id => !!id && historyIds.has(id));
}

export const SESSION_RECORD_RETENTION_MS = 30 * 86_400_000;
export async function listSessionStateCandidates(stateDir: string, metadataDir: string, liveIds: ReadonlySet<string>, now = Date.now(), history: readonly SessionStateHistoryIdentity[] = []): Promise<StorageFile[]> {
  const states = (await listStorageFiles(stateDir, false)).filter(file => file.path.endsWith('.json') && file.modifiedAt < now - SESSION_RECORD_RETENTION_MS && !liveIds.has(path.basename(file.path, '.json')));
  const metadata = new Map((await listStorageFiles(metadataDir, false)).map(file => [path.basename(file.path), file]));
  const historyIds = sessionStateHistoryIds(history);
  return (await mapStorageFiles(states, async file => {
    const instanceId = path.basename(file.path, '.json');
    const sidecar = metadata.get(path.basename(file.path));
    if (!await sessionStateIsAbsentFromHistory(file, sidecar, historyIds)) return [];
    return [file, ...(sidecar ? [sidecar] : [])].map(item => ({ ...item, instanceId }));
  })).flat().sort((a, b) => a.path.localeCompare(b.path));
}
export async function removeSessionStateCandidates(files: readonly StorageFile[], stateDir: string, metadataDir: string, getLiveIds: () => ReadonlySet<string>, now = Date.now(), history: readonly SessionStateHistoryIdentity[] = []): Promise<number> {
  const current = await listSessionStateCandidates(stateDir, metadataDir, getLiveIds(), now, history);
  if (files.some(file => !current.some(candidate => JSON.stringify(candidate) === JSON.stringify(file)))) throw new Error('The list changed since you looked. Review again.');
  return removeStorageFiles(files, [stateDir, metadataDir], getLiveIds);
}
