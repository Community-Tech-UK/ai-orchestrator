import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createFileDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    // ============================================
    // Dialogs
    // ============================================

    /**
     * Open folder selection dialog
     * Returns the selected folder path or null if cancelled
     */
    selectFolder: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DIALOG_SELECT_FOLDER);
    },

    /**
     * Open file selection dialog
     * Returns the selected file paths or null if cancelled
     */
    selectFiles: (options?: {
      multiple?: boolean;
      defaultPath?: string;
      filters?: { name: string; extensions: string[] }[];
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DIALOG_SELECT_FILES, options);
    },

    // ============================================
    // Recent Directories
    // ============================================

    /**
     * Get recent directories
     */
    getRecentDirectories: (options?: {
      limit?: number;
      sortBy?: 'lastAccessed' | 'frequency' | 'alphabetical' | 'manual';
      includePinned?: boolean;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RECENT_DIRS_GET, options);
    },

    /**
     * Add a directory to recent list
     */
    addRecentDirectory: (path: string, options?: { nodeId?: string; platform?: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RECENT_DIRS_ADD, { path, ...options });
    },

    /**
     * Remove a directory from recent list
     */
    removeRecentDirectory: (path: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RECENT_DIRS_REMOVE, { path });
    },

    /**
     * Pin or unpin a directory
     */
    pinRecentDirectory: (path: string, pinned: boolean): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RECENT_DIRS_PIN, { path, pinned });
    },

    /**
     * Persist a manual order for recent directories
     */
    reorderRecentDirectories: (paths: string[]): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RECENT_DIRS_REORDER, { paths });
    },

    /**
     * Clear all recent directories
     */
    clearRecentDirectories: (keepPinned?: boolean): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.RECENT_DIRS_CLEAR, { keepPinned });
    },

    // ============================================
    // File Operations
    // ============================================

    /**
     * Read directory contents
     */
    readDir: (path: string, includeHidden?: boolean): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.FILE_READ_DIR, {
        path,
        includeHidden
      });
    },

    /**
     * Get file stats
     */
    getFileStats: (path: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.FILE_GET_STATS, { path });
    },

    /**
     * Open a file or folder with the system's default application
     */
    openPath: (path: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.FILE_OPEN_PATH, { path });
    },

    /**
     * Read a text file
     */
    readTextFile: (path: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.FILE_READ_TEXT, { path });
    },

    /**
     * Write a text file
     */
    writeTextFile: (payload: {
      path: string;
      content: string;
      createDirs?: boolean;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.FILE_WRITE_TEXT, payload);
    },

    // ============================================
    // Image Operations
    // ============================================

    /**
     * Copy an image (base64 data URL) to the system clipboard as a native image
     */
    imageCopyToClipboard: (payload: {
      dataUrl: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.IMAGE_COPY_TO_CLIPBOARD, payload);
    },

    /**
     * Show a native context menu for an image (Copy Image, Save Image As...)
     */
    imageContextMenu: (payload: {
      dataUrl: string;
      filename: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.IMAGE_CONTEXT_MENU, payload);
    },

    /**
     * Open a documentation file from the docs folder
     */
    openDocsFile: (filename: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.APP_OPEN_DOCS, { filename });
    },

    // ============================================
    // Ecosystem (file-based extensibility)
    // ============================================

    /**
     * List ecosystem items (commands, agents, tools, plugins)
     */
    ecosystemList: (payload: {
      workingDirectory: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.ECOSYSTEM_LIST, payload);
    },

    /**
     * Start watching a directory for ecosystem changes
     */
    ecosystemWatchStart: (payload: {
      workingDirectory: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.ECOSYSTEM_WATCH_START, payload);
    },

    /**
     * Stop watching a directory for ecosystem changes
     */
    ecosystemWatchStop: (payload: {
      workingDirectory: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.ECOSYSTEM_WATCH_STOP, payload);
    },

    /**
     * Listen for ecosystem change events
     */
    onEcosystemChanged: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.ECOSYSTEM_CHANGED, handler);
      return () => ipcRenderer.removeListener(ch.ECOSYSTEM_CHANGED, handler);
    },

    // ============================================
    // Editor (extended)
    // ============================================

    /**
     * Open a file in the configured editor
     */
    editorOpenFile: (payload: {
      filePath: string;
      options?: Record<string, unknown>;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.EDITOR_OPEN_FILE, payload);
    },

    /**
     * Open a file at a specific line in the configured editor
     */
    editorOpenFileAtLine: (payload: {
      filePath: string;
      line: number;
      column?: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.EDITOR_OPEN_FILE_AT_LINE, payload);
    },

    /**
     * Open a directory in the configured editor
     */
    editorOpenDirectory: (payload: {
      dirPath: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.EDITOR_OPEN_DIRECTORY, payload);
    },

    /**
     * Set the preferred editor
     */
    editorSetPreferred: (editorId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.EDITOR_SET_PREFERRED, { editorId });
    },

    /**
     * Get the preferred editor
     */
    editorGetPreferred: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.EDITOR_GET_PREFERRED);
    },

    // ============================================
    // External Editor (9.2)
    // ============================================

    /**
     * Detect available editors
     */
    editorDetect: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.EDITOR_DETECT);
    },

    /**
     * Open file in external editor
     */
    editorOpen: (
      filePath: string,
      options?: {
        editor?: string;
        line?: number;
        column?: number;
        waitForClose?: boolean;
      }
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.EDITOR_OPEN, { filePath, options });
    },

    /**
     * Get available editors
     */
    editorGetAvailable: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.EDITOR_GET_AVAILABLE);
    },

    /**
     * Set default editor
     */
    editorSetDefault: (editorId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.EDITOR_SET_DEFAULT, { editorId });
    },

    /**
     * Get default editor
     */
    editorGetDefault: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.EDITOR_GET_DEFAULT);
    },

    // ============================================
    // File Watcher (10.1)
    // ============================================

    /**
     * Watch a path for changes
     */
    watcherWatch: (
      path: string,
      options?: {
        recursive?: boolean;
        patterns?: string[];
        ignorePatterns?: string[];
        debounceMs?: number;
      }
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WATCHER_WATCH, { path, options });
    },

    /**
     * Stop watching a path
     */
    watcherUnwatch: (watcherId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WATCHER_UNWATCH, { watcherId });
    },

    /**
     * Get active watchers
     */
    watcherGetActive: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WATCHER_GET_ACTIVE);
    },

    /**
     * Listen for file change events
     */
    onWatcherFileChanged: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('watcher:file-changed', handler);
      return () => ipcRenderer.removeListener('watcher:file-changed', handler);
    },

    /**
     * Listen for file added events
     */
    onWatcherFileAdded: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('watcher:file-added', handler);
      return () => ipcRenderer.removeListener('watcher:file-added', handler);
    },

    /**
     * Listen for file removed events
     */
    onWatcherFileRemoved: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('watcher:file-removed', handler);
      return () => ipcRenderer.removeListener('watcher:file-removed', handler);
    },

    /**
     * Listen for watcher errors
     */
    onWatcherError: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('watcher:error', handler);
      return () => ipcRenderer.removeListener('watcher:error', handler);
    },
  };
}
