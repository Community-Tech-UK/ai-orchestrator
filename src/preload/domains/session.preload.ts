import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createSessionDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    // ============================================
    // Session Operations
    // ============================================

    /**
     * Fork a session at a specific message point
     */
    forkSession: (payload: {
      instanceId: string;
      atMessageIndex?: number;
      displayName?: string;
      initialPrompt?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SESSION_FORK, payload);
    },

    /**
     * Export a session to JSON or Markdown
     */
    exportSession: (payload: {
      instanceId: string;
      format: 'json' | 'markdown';
      includeMetadata?: boolean;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SESSION_EXPORT, payload);
    },

    /**
     * Import a session from a file
     */
    importSession: (payload: {
      filePath: string;
      workingDirectory?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SESSION_IMPORT, payload);
    },

    /**
     * Copy session to clipboard
     */
    copySessionToClipboard: (payload: {
      instanceId: string;
      format: 'json' | 'markdown';
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SESSION_COPY_TO_CLIPBOARD, payload);
    },

    /**
     * Save session to file
     */
    saveSessionToFile: (payload: {
      instanceId: string;
      format: 'json' | 'markdown';
      filePath?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SESSION_SAVE_TO_FILE, payload);
    },

    /**
     * Reveal a file in the system file manager
     */
    revealFile: (filePath: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SESSION_REVEAL_FILE, { filePath });
    },

    /**
     * Build an in-memory redacted share bundle for an instance or history entry
     */
    sessionSharePreview: (payload: {
      instanceId?: string;
      entryId?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SESSION_SHARE_PREVIEW, payload);
    },

    /**
     * Save a redacted share bundle to disk
     */
    sessionShareSave: (payload: {
      instanceId?: string;
      entryId?: string;
      filePath?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SESSION_SHARE_SAVE, payload);
    },

    /**
     * Load a previously saved share bundle from disk
     */
    sessionShareLoad: (payload: {
      filePath: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SESSION_SHARE_LOAD, payload);
    },

    /**
     * Replay a saved share bundle into a new local instance
     */
    sessionShareReplay: (payload: {
      filePath: string;
      workingDirectory: string;
      displayName?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SESSION_SHARE_REPLAY, payload);
    },

    // Session continuity
    listResumableSessions: () => ipcRenderer.invoke(ch.SESSION_LIST_RESUMABLE),
    resumeSession: (payload: { instanceId: string; options?: Record<string, unknown> }) =>
      ipcRenderer.invoke(ch.SESSION_RESUME, payload),
    listSessionSnapshots: (payload?: { instanceId?: string }) =>
      ipcRenderer.invoke(ch.SESSION_LIST_SNAPSHOTS, payload),
    createSessionSnapshot: (payload: { instanceId: string; name?: string; description?: string }) =>
      ipcRenderer.invoke(ch.SESSION_CREATE_SNAPSHOT, payload),
    getSessionStats: () => ipcRenderer.invoke(ch.SESSION_GET_STATS),

    // ============================================
    // History
    // ============================================

    /**
     * Get history entries
     */
    listHistory: (options?: {
      limit?: number;
      searchQuery?: string;
      workingDirectory?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.HISTORY_LIST, options || {});
    },

    /**
     * Load full conversation data for a history entry
     */
    loadHistoryEntry: (entryId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.HISTORY_LOAD, { entryId });
    },

    /**
     * Archive a history entry
     */
    archiveHistoryEntry: (entryId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.HISTORY_ARCHIVE, { entryId });
    },

    /**
     * Delete a history entry
     */
    deleteHistoryEntry: (entryId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.HISTORY_DELETE, { entryId });
    },

    /**
     * Restore a conversation from history as a new instance
     */
    restoreHistory: (
      entryId: string,
      workingDirectory?: string
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.HISTORY_RESTORE, {
        entryId,
        workingDirectory
      });
    },

    /**
     * Clear all history
     */
    clearHistory: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.HISTORY_CLEAR);
    },

    // ============================================
    // Snapshot Operations (File Revert)
    // ============================================

    /**
     * Take a snapshot before file modification
     */
    snapshotTake: (payload: {
      filePath: string;
      instanceId: string;
      sessionId?: string;
      action?: 'create' | 'modify' | 'delete';
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SNAPSHOT_TAKE, payload);
    },

    /**
     * Start a snapshot session
     */
    snapshotStartSession: (
      instanceId: string,
      description?: string
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SNAPSHOT_START_SESSION, {
        instanceId,
        description
      });
    },

    /**
     * End a snapshot session
     */
    snapshotEndSession: (sessionId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SNAPSHOT_END_SESSION, { sessionId });
    },

    /**
     * Get all snapshots for an instance
     */
    snapshotGetForInstance: (instanceId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SNAPSHOT_GET_FOR_INSTANCE, {
        instanceId
      });
    },

    /**
     * Get all snapshots for a file
     */
    snapshotGetForFile: (filePath: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SNAPSHOT_GET_FOR_FILE, { filePath });
    },

    /**
     * Get all sessions for an instance
     */
    snapshotGetSessions: (instanceId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SNAPSHOT_GET_SESSIONS, {
        instanceId
      });
    },

    /**
     * Get content from a snapshot
     */
    snapshotGetContent: (snapshotId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SNAPSHOT_GET_CONTENT, {
        snapshotId
      });
    },

    /**
     * Revert a file to a specific snapshot
     */
    snapshotRevertFile: (snapshotId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SNAPSHOT_REVERT_FILE, {
        snapshotId
      });
    },

    /**
     * Revert all files in a session
     */
    snapshotRevertSession: (sessionId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SNAPSHOT_REVERT_SESSION, {
        sessionId
      });
    },

    /**
     * Get diff between snapshot and current file
     */
    snapshotGetDiff: (snapshotId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SNAPSHOT_GET_DIFF, { snapshotId });
    },

    /**
     * Delete a snapshot
     */
    snapshotDelete: (snapshotId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SNAPSHOT_DELETE, { snapshotId });
    },

    /**
     * Cleanup old snapshots
     */
    snapshotCleanup: (maxAgeDays?: number): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SNAPSHOT_CLEANUP, { maxAgeDays });
    },

    /**
     * Get snapshot storage stats
     */
    snapshotGetStats: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SNAPSHOT_GET_STATS);
    },

    // ============================================
    // Session Archive (1.3)
    // ============================================

    /**
     * Archive a session
     */
    archiveSession: (
      sessionId: string,
      sessionData: unknown,
      options?: { compress?: boolean; metadata?: Record<string, unknown> }
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.ARCHIVE_SESSION, {
        sessionId,
        sessionData,
        options
      });
    },

    /**
     * List archives
     */
    archiveList: (filter?: {
      startDate?: number;
      endDate?: number;
      limit?: number;
      tags?: string[];
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.ARCHIVE_LIST, { filter });
    },

    /**
     * Restore archive
     */
    archiveRestore: (archiveId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.ARCHIVE_RESTORE, { archiveId });
    },

    /**
     * Delete archive
     */
    archiveDelete: (archiveId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.ARCHIVE_DELETE, { archiveId });
    },

    /**
     * Search archives
     */
    archiveSearch: (
      query: string,
      options?: { limit?: number; fields?: string[] }
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.ARCHIVE_SEARCH, { query, options });
    },
  };
}
