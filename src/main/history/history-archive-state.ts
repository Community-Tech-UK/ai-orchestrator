import type { ConversationData, ConversationHistoryEntry, HistoryIndex } from '../../shared/types/history.types';
import { KeyedSerialTaskQueue } from './history-archive-serialization';
import { getSessionRecoveryCandidateServiceIfInitialized } from '../session/session-recovery-candidate-service';
export interface HistoryArchiveStateDeps {
  index: HistoryIndex;
  updateConversation: (id: string, update: (entry: ConversationHistoryEntry) => void) => Promise<ConversationData | null>;
  saveIndex: () => Promise<void>;
}
export async function archiveHistoryEntry(deps: HistoryArchiveStateDeps, entryId: string): Promise<boolean> {
  return stateQueue(deps.index).run(entryId, () => setArchiveState(deps, entryId, true));
}
export async function unarchiveHistoryEntry(deps: HistoryArchiveStateDeps, entryId: string): Promise<boolean> {
  return stateQueue(deps.index).run(entryId, () => setArchiveState(deps, entryId, false));
}
const queues = new WeakMap<HistoryIndex, KeyedSerialTaskQueue>();
function stateQueue(index: HistoryIndex): KeyedSerialTaskQueue {
  let queue = queues.get(index);
  if (!queue) { queue = new KeyedSerialTaskQueue(); queues.set(index, queue); }
  return queue;
}
async function setArchiveState(deps: HistoryArchiveStateDeps, entryId: string, archived: boolean): Promise<boolean> {
  const entry = deps.index.entries.find((item) => item.id === entryId);
  if (!entry) return false;
  if (Boolean(entry.archivedAt) === archived) return true;
  const previousArchive = entry.archivedAt;
  const nextArchive = archived ? Date.now() : undefined;
  let previousStoredArchive: ConversationHistoryEntry['archivedAt'];
  const conversation = await deps.updateConversation(entryId, (stored) => {
    previousStoredArchive = stored.archivedAt; stored.archivedAt = nextArchive;
  });
  // Legacy orphan entries can be hidden without a conversation file. Restoring
  // one cannot succeed unless its transcript still exists.
  if ((!conversation && !archived) || !deps.index.entries.includes(entry)) return false;
  entry.archivedAt = nextArchive;
  deps.index.lastUpdated = Date.now();
  try {
    await deps.saveIndex();
  } catch (error) {
    entry.archivedAt = previousArchive;
    // Keep lastUpdated: rolling its timestamp back could erase a concurrent
    // change to another entry, and this compensation is itself a mutation.
    // Keep disk and memory aligned when possible; the original write failure
    // remains authoritative even if the compensating conversation write fails.
    if (conversation) {
      try { await deps.updateConversation(entryId, (stored) => { stored.archivedAt = previousStoredArchive; }); } catch { /* retry remains possible */ }
    }
    try { await deps.saveIndex(); } catch { /* the caller receives the original failure */ }
    throw error;
  }
  getSessionRecoveryCandidateServiceIfInitialized()?.invalidate();
  return true;
}
