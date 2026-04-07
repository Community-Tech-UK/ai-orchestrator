/**
 * Recent Directories IPC Service - Frontend service for recent directories operations
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService } from './electron-ipc.service';
import type { RecentDirectoryEntry, RecentDirectoriesOptions } from '../../../../../shared/types/recent-directories.types';

@Injectable({ providedIn: 'root' })
export class RecentDirectoriesIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  /**
   * Get recent directories
   */
  async getDirectories(options?: RecentDirectoriesOptions): Promise<RecentDirectoryEntry[]> {
    if (!this.api) return [];
    const response = await this.api.getRecentDirectories(options);
    return response.success ? (response.data as RecentDirectoryEntry[]) : [];
  }

  /**
   * Add a directory to recent list
   * Returns the added/updated entry or null on failure
   * Pass options.nodeId for remote paths to skip local existence validation
   */
  async addDirectory(path: string, options?: { nodeId?: string; platform?: string }): Promise<RecentDirectoryEntry | null> {
    if (!this.api) return null;
    const response = await this.api.addRecentDirectory(path, options);
    return response.success ? (response.data as RecentDirectoryEntry) : null;
  }

  /**
   * Remove a directory from recent list
   * Returns true if removed, false otherwise
   */
  async removeDirectory(path: string): Promise<boolean> {
    if (!this.api) return false;
    const response = await this.api.removeRecentDirectory(path);
    return response.success && (response.data as { removed: boolean })?.removed;
  }

  /**
   * Pin or unpin a directory
   * Returns true if operation succeeded
   */
  async pinDirectory(path: string, pinned: boolean): Promise<boolean> {
    if (!this.api) return false;
    const response = await this.api.pinRecentDirectory(path, pinned);
    return response.success;
  }

  /**
   * Persist a manual order for recent directories
   */
  async reorderDirectories(paths: string[]): Promise<boolean> {
    if (!this.api) return false;
    const response = await this.api.reorderRecentDirectories(paths);
    return response.success && (response.data as { reordered: boolean } | undefined)?.reordered !== false;
  }

  /**
   * Clear all recent directories
   * @param keepPinned - If true, keeps pinned directories (default: true)
   */
  async clearAll(keepPinned = true): Promise<boolean> {
    if (!this.api) return false;
    const response = await this.api.clearRecentDirectories(keepPinned);
    return response.success;
  }

  /**
   * Select folder and auto-add to recent directories
   * Combines folder selection with automatic tracking
   * Returns the selected path or null if cancelled
   */
  async selectFolderAndTrack(): Promise<string | null> {
    if (!this.api) return null;

    // Use the existing selectFolder API
    const response = await this.api.selectFolder();
    if (!response.success || !response.data) {
      return null;
    }

    const selectedPath = response.data as string;

    // Auto-add to recent directories
    await this.addDirectory(selectedPath);

    return selectedPath;
  }
}
