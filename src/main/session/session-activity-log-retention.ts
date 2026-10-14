import { promises as fs } from 'fs';
import * as path from 'path';
import { listStorageFiles, mapStorageFiles, removeStorageFiles, safeStorageDirectory, type StorageFile } from '../storage/storage-files';
import { SESSION_RECORD_RETENTION_MS } from './session-state-retention';

export async function listSessionActivityLogCandidates(projectsRoot: string, liveIds: ReadonlySet<string>, now = Date.now()): Promise<StorageFile[]> {
  if (!await safeStorageDirectory(projectsRoot)) return [];
  const projects = await fs.readdir(projectsRoot, { withFileTypes: true });
  const groups = await mapStorageFiles(projects.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()), async entry => {
    const files = await listStorageFiles(path.join(projectsRoot, entry.name, 'session-events'), false);
    return files.filter(file => file.path.endsWith('.jsonl') && file.modifiedAt < now - SESSION_RECORD_RETENTION_MS && !liveIds.has(path.basename(file.path, '.jsonl')))
      .map(file => ({ ...file, instanceId: path.basename(file.path, '.jsonl') }));
  });
  return groups.flat().sort((a, b) => a.path.localeCompare(b.path));
}
export async function removeSessionActivityLogCandidates(files: readonly StorageFile[], projectsRoot: string, getLiveIds: () => ReadonlySet<string>, now = Date.now()): Promise<number> {
  const current = await listSessionActivityLogCandidates(projectsRoot, getLiveIds(), now);
  if (files.some(file => !current.some(candidate => JSON.stringify(candidate) === JSON.stringify(file)))) throw new Error('The list changed since you looked. Review again.');
  return removeStorageFiles(files, [projectsRoot], getLiveIds);
}
