/**
 * History IPC Service - Session history and export operations
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class HistoryIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  // ============================================
  // History
  // ============================================

  /**
   * Get history entries
   */
  async listHistory(options?: {
    limit?: number;
    searchQuery?: string;
    workingDirectory?: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.listHistory(options);
  }

  /**
   * Load full conversation data for a history entry
   */
  async loadHistoryEntry(entryId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.loadHistoryEntry(entryId);
  }

  /**
   * Archive a history entry
   */
  async archiveHistoryEntry(entryId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.archiveHistoryEntry(entryId);
  }

  /**
   * Delete a history entry
   */
  async deleteHistoryEntry(entryId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.deleteHistoryEntry(entryId);
  }

  /**
   * Restore a conversation from history as a new instance
   */
  async restoreHistory(entryId: string, workingDirectory?: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.restoreHistory(entryId, workingDirectory);
  }

  /**
   * Clear all history
   */
  async clearHistory(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.clearHistory();
  }

  // ============================================
  // Session Operations
  // ============================================

  /**
   * Fork a session at a specific message point
   */
  async forkSession(
    instanceId: string,
    atMessageIndex?: number,
    displayName?: string,
    initialPrompt?: string,
  ): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.forkSession({ instanceId, atMessageIndex, displayName, initialPrompt });
  }

  /**
   * Export a session to JSON or Markdown
   */
  async exportSession(instanceId: string, format: 'json' | 'markdown'): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.exportSession({ instanceId, format });
  }

  /**
   * Import a session from a file
   */
  async importSession(filePath: string, workingDirectory?: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.importSession({ filePath, workingDirectory });
  }

  /**
   * Copy session to clipboard
   */
  async copySessionToClipboard(instanceId: string, format: 'json' | 'markdown'): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.copySessionToClipboard({ instanceId, format });
  }

  /**
   * Save session to file
   */
  async saveSessionToFile(instanceId: string, format: 'json' | 'markdown', filePath?: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.saveSessionToFile({ instanceId, format, filePath });
  }

  // ============================================
  // Session Archive
  // ============================================

  /**
   * Archive a session
   */
  async archiveSession(
    sessionId: string,
    sessionData: unknown,
    options?: { compress?: boolean; metadata?: Record<string, unknown> }
  ): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.archiveSession(sessionId, sessionData, options);
  }

  /**
   * List archives
   */
  async archiveList(filter?: {
    startDate?: number;
    endDate?: number;
    limit?: number;
    tags?: string[];
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.archiveList(filter);
  }

  /**
   * Restore archive
   */
  async archiveRestore(archiveId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.archiveRestore(archiveId);
  }

  /**
   * Delete archive
   */
  async archiveDelete(archiveId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.archiveDelete(archiveId);
  }

  /**
   * Search archives
   */
  async archiveSearch(query: string, options?: { limit?: number; fields?: string[] }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.archiveSearch(query, options);
  }
}
