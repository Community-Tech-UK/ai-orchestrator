/**
 * File IPC Service - File, folder, and path operations
 */

import { Injectable, inject } from '@angular/core';
import type {
  ImageResolveRequest,
  ImageResolveResponse,
} from '@contracts/schemas/image';
import { ElectronIpcService, IpcResponse, FileEntry } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class FileIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  private get ngZone() {
    return this.base.getNgZone();
  }

  // ============================================
  // Dialogs
  // ============================================

  /**
   * Open folder selection dialog
   * Returns the selected folder path or null if cancelled
   */
  async selectFolder(): Promise<string | null> {
    if (!this.api) return null;
    const response = await this.api.selectFolder();
    return response.success ? (response.data as string | null) : null;
  }

  /**
   * Open file selection dialog
   * Returns the selected file paths or null if cancelled
   */
  async selectFiles(options?: {
    multiple?: boolean;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<string[] | null> {
    if (!this.api) return null;
    const response = await this.api.selectFiles(options);
    return response.success ? (response.data as string[] | null) : null;
  }

  // ============================================
  // File Operations
  // ============================================

  /**
   * Read directory contents
   */
  async readDir(path: string, includeHidden?: boolean): Promise<FileEntry[] | null> {
    if (!this.api) return null;
    const response = await this.api.readDir(path, includeHidden);
    return response.success ? (response.data as FileEntry[]) : null;
  }

  /**
   * Get file stats
   */
  async getFileStats(path: string): Promise<FileEntry | null> {
    if (!this.api) return null;
    const response = await this.api.getFileStats(path);
    return response.success ? (response.data as FileEntry) : null;
  }

  /**
   * Read a file's raw bytes via IPC. Returns null if the call fails.
   * The main process returns the bytes base64-encoded; this method decodes
   * them back into a fresh ArrayBuffer for the renderer (CSP blocks
   * `fetch('file://...')`, so callers can't load files directly).
   */
  async readFileBytes(
    path: string,
    maxBytes?: number
  ): Promise<{ buffer: ArrayBuffer; truncated: boolean; totalSize: number } | null> {
    if (!this.api) return null;
    const response = await this.api.readFileBytes(path, maxBytes);
    if (!response.success) return null;
    const data = response.data as {
      base64: string;
      byteLength: number;
      totalSize: number;
      truncated: boolean;
    };
    const binary = atob(data.base64);
    const buffer = new ArrayBuffer(binary.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i++) {
      view[i] = binary.charCodeAt(i);
    }
    return { buffer, truncated: data.truncated, totalSize: data.totalSize };
  }

  /**
   * Open a file or folder with the system's default application
   */
  async openPath(path: string): Promise<boolean> {
    if (!this.api) return false;
    const response = await this.api.openPath(path);
    return response.success;
  }

  /**
   * Open the system terminal at the given directory.
   *
   * Returns an `IpcResponse` so callers can surface a useful error message
   * when no terminal emulator is available on Linux, etc.
   */
  async openTerminalAtPath(path: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.openTerminalAtPath(path);
  }

  /**
   * Copy a file or folder reference to the system clipboard for paste in the OS file manager
   */
  async copyFileToClipboard(path: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.copyFileToClipboard(path);
  }

  /**
   * Resolve an inline image reference into a renderer attachment payload.
   */
  async resolveImage(payload: ImageResolveRequest): Promise<ImageResolveResponse | null> {
    if (!this.api) return null;
    const response = await this.api.imageResolve(payload);
    return response.success ? (response.data as ImageResolveResponse) : null;
  }

  /**
   * Reveal a file in the system file manager
   */
  async revealFile(filePath: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.revealFile(filePath);
  }

  // ============================================
  // File Watcher
  // ============================================

  /**
   * Watch a path for changes
   */
  async watcherWatch(
    path: string,
    options?: { recursive?: boolean; patterns?: string[]; ignorePatterns?: string[]; debounceMs?: number }
  ): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.watcherWatch(path, options);
  }

  /**
   * Stop watching a path
   */
  async watcherUnwatch(watcherId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.watcherUnwatch(watcherId);
  }

  /**
   * Get active watchers
   */
  async watcherGetActive(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.watcherGetActive();
  }

  /**
   * Listen for file change events
   */
  onWatcherFileChanged(callback: (data: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onWatcherFileChanged((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  /**
   * Listen for file added events
   */
  onWatcherFileAdded(callback: (data: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onWatcherFileAdded((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  /**
   * Listen for file removed events
   */
  onWatcherFileRemoved(callback: (data: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onWatcherFileRemoved((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  /**
   * Listen for watcher errors
   */
  onWatcherError(callback: (data: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onWatcherError((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  // ============================================
  // External Editor
  // ============================================

  /**
   * Detect available editors and refresh the preferred editor choice
   */
  async editorDetect(): Promise<IpcResponse> {
    return this.base.invoke('editor:detect');
  }

  /**
   * Open file in external editor
   */
  async editorOpen(
    filePath: string,
    options?: { editor?: string; line?: number; column?: number; waitForClose?: boolean }
  ): Promise<IpcResponse> {
    return this.editorOpenFile(filePath, options);
  }

  /**
   * Open a file in the configured editor (routes to the handled EDITOR_OPEN_FILE channel).
   */
  async editorOpenFile(
    filePath: string,
    options?: { line?: number; column?: number; waitForClose?: boolean; newWindow?: boolean }
  ): Promise<IpcResponse> {
    return this.base.invoke('editor:open-file', { filePath, ...options });
  }

  /**
   * Open a file at a specific line in the configured editor
   * (routes to the handled EDITOR_OPEN_FILE_AT_LINE channel).
   */
  async editorOpenFileAtLine(filePath: string, line: number, column?: number): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.editorOpenFileAtLine({ filePath, line, column });
  }

  /**
   * Open a directory in the configured editor
   */
  async editorOpenDirectory(dirPath: string): Promise<IpcResponse> {
    return this.base.invoke('editor:open-directory', { dirPath });
  }

  /**
   * Get available editors
   */
  async editorGetAvailable(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.editorGetAvailable();
  }

  /**
   * Set default editor
   */
  async editorSetDefault(editorId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.editorSetDefault(editorId);
  }

  /**
   * Get default editor
   */
  async editorGetDefault(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.editorGetDefault();
  }

  // ============================================
  // Multi-Edit Operations
  // ============================================

  /**
   * Preview edits without applying them
   * Returns what would happen if edits were applied
   */
  async multiEditPreview(edits: {
    filePath: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  }[]): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.multiEditPreview({ edits });
  }

  /**
   * Apply edits atomically (all succeed or all fail)
   * Optionally takes snapshots before modifications
   */
  async multiEditApply(
    edits: {
      filePath: string;
      oldString: string;
      newString: string;
      replaceAll?: boolean;
    }[],
    options: {
      instanceId?: string;
      takeSnapshots?: boolean;
    } = {}
  ): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.multiEditApply({
      edits,
      instanceId: options.instanceId,
      takeSnapshots: options.takeSnapshots,
    });
  }
}
