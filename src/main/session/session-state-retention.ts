import * as path from 'path';
import { listStorageFiles, removeStorageFiles, type StorageFile } from '../storage/storage-files';

export const SESSION_RECORD_RETENTION_MS = 30 * 86_400_000;
export async function listSessionStateCandidates(stateDir: string, metadataDir: string, liveIds: ReadonlySet<string>, now = Date.now()): Promise<StorageFile[]> {
  const states = (await listStorageFiles(stateDir, false)).filter(file => file.path.endsWith('.json') && file.modifiedAt < now - SESSION_RECORD_RETENTION_MS && !liveIds.has(path.basename(file.path, '.json')));
  const metadata = new Map((await listStorageFiles(metadataDir, false)).map(file => [path.basename(file.path), file]));
  return states.flatMap(file => {
    const instanceId = path.basename(file.path, '.json');
    const sidecar = metadata.get(path.basename(file.path));
    return [file, ...(sidecar ? [sidecar] : [])].map(item => ({ ...item, instanceId }));
  }).sort((a, b) => a.path.localeCompare(b.path));
}
export async function removeSessionStateCandidates(files: readonly StorageFile[], stateDir: string, metadataDir: string, getLiveIds: () => ReadonlySet<string>, now = Date.now()): Promise<number> {
  const current = await listSessionStateCandidates(stateDir, metadataDir, getLiveIds(), now);
  if (files.some(file => !current.some(candidate => JSON.stringify(candidate) === JSON.stringify(file)))) throw new Error('The list changed since you looked. Review again.');
  return removeStorageFiles(files, [stateDir, metadataDir], getLiveIds);
}
