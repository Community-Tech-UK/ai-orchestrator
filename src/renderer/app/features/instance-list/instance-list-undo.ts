import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import type { HistoryStore } from '../../core/state/history.store';
import type { UndoService } from '../../core/services/undo.service';
import type { ToastService } from '../../core/services/toast.service';
import type { RecentDirectoriesIpcService } from '../../core/services/ipc/recent-directories-ipc.service';
import type { ProjectGroup } from './instance-list.types';
import { getAllProjectHistoryItems } from './project-rail-tree.utils';
interface ArchiveUndoDeps {
  history: Pick<HistoryStore, 'archiveEntry' | 'unarchiveEntry'>;
  undo: Pick<UndoService, 'register'>;
  toast: Pick<ToastService, 'show'>;
}
interface ProjectUndoDeps extends ArchiveUndoDeps {
  recent: Pick<RecentDirectoriesIpcService, 'removeDirectory' | 'pinDirectory'> & {
    addDirectory: (path: string, options?: { nodeId?: string }) => Promise<unknown>;
  };
  reload: () => Promise<void>;
}
export async function archiveWithUndo(entry: ConversationHistoryEntry, deps: ArchiveUndoDeps): Promise<void> {
  if (entry.archivedAt) return;
  try {
    if (!await deps.history.archiveEntry(entry.id)) throw new Error('unavailable');
    deps.undo.register({ kind: 'archive-thread', message: `Archived "${entry.displayName}"`, undo: () => deps.history.unarchiveEntry(entry.id) });
  } catch { deps.toast.show("Couldn't archive that session.", 'error'); }
}
export async function removeProjectWithUndo(group: ProjectGroup, nodeId: string | null, deps: ProjectUndoDeps): Promise<void> {
  const path = group.path;
  if (!path) return;
  const archived: string[] = [];
  let removed = false;
  try {
    for (const entry of getAllProjectHistoryItems(group)) {
      if (entry.archivedAt) continue;
      if (!await deps.history.archiveEntry(entry.id)) throw new Error('unavailable');
      archived.push(entry.id);
    }
    removed = await deps.recent.removeDirectory(path);
    if (!removed) throw new Error('unavailable');
    await deps.reload();
  } catch { deps.toast.show("Couldn't remove the whole project. You can undo any threads already archived.", 'error'); }
  if (!removed && archived.length === 0) return;
  deps.undo.register({ kind: 'remove-project', message: `${removed ? 'Removed' : 'Kept'} ${group.title} and archived ${archived.length} ${archived.length === 1 ? 'thread' : 'threads'}`, undo: async () => {
    let restored = true;
    for (const id of archived) if (!await deps.history.unarchiveEntry(id)) restored = false;
    if (removed) {
      if (!await deps.recent.addDirectory(path, nodeId ? { nodeId } : undefined)) restored = false;
      if (group.isPinned && !await deps.recent.pinDirectory(path, true)) restored = false;
    }
    await deps.reload();
    return restored;
  } });
}
