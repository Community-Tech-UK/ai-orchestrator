/**
 * Electron IPC Service - Bridge between Angular and Electron main process
 */

import { Injectable, NgZone, inject } from '@angular/core';
import type { ElectronAPI } from '../../../../preload/preload';

// Declare the electronAPI on window
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

@Injectable({ providedIn: 'root' })
export class ElectronIpcService {
  private ngZone = inject(NgZone);
  private api: ElectronAPI | null = null;

  constructor() {
    // Access the API exposed by preload script
    if (typeof window !== 'undefined' && window.electronAPI) {
      this.api = window.electronAPI;
    } else {
      console.warn('Electron API not available - running in browser mode');
    }
  }

  /**
   * Check if running in Electron
   */
  get isElectron(): boolean {
    return this.api !== null;
  }

  /**
   * Get current platform
   */
  get platform(): string {
    return this.api?.platform || 'browser';
  }

  // ============================================
  // Instance Management
  // ============================================

  /**
   * Create a new instance
   */
  async createInstance(config: {
    workingDirectory: string;
    displayName?: string;
    parentInstanceId?: string;
    initialPrompt?: string;
    yoloMode?: boolean;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.createInstance(config);
  }

  /**
   * Send input to an instance
   */
  async sendInput(instanceId: string, message: string, attachments?: any[]) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.sendInput({ instanceId, message, attachments });
  }

  /**
   * Terminate an instance
   */
  async terminateInstance(instanceId: string, graceful = true) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.terminateInstance({ instanceId, graceful });
  }

  /**
   * Restart an instance
   */
  async restartInstance(instanceId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.restartInstance({ instanceId });
  }

  /**
   * Rename an instance
   */
  async renameInstance(instanceId: string, displayName: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.renameInstance({ instanceId, displayName });
  }

  /**
   * Terminate all instances
   */
  async terminateAllInstances() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.terminateAllInstances();
  }

  /**
   * Get all instances
   */
  async listInstances() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.listInstances();
  }

  // ============================================
  // Event Subscriptions
  // ============================================

  /**
   * Subscribe to instance created events
   */
  onInstanceCreated(callback: (instance: unknown) => void): () => void {
    if (!this.api) return () => {};

    return this.api.onInstanceCreated((instance) => {
      this.ngZone.run(() => callback(instance));
    });
  }

  /**
   * Subscribe to instance removed events
   */
  onInstanceRemoved(callback: (instanceId: string) => void): () => void {
    if (!this.api) return () => {};

    return this.api.onInstanceRemoved((instanceId) => {
      this.ngZone.run(() => callback(instanceId));
    });
  }

  /**
   * Subscribe to instance state updates
   */
  onInstanceStateUpdate(callback: (update: unknown) => void): () => void {
    if (!this.api) return () => {};

    return this.api.onInstanceStateUpdate((update) => {
      this.ngZone.run(() => callback(update));
    });
  }

  /**
   * Subscribe to instance output
   */
  onInstanceOutput(callback: (output: unknown) => void): () => void {
    if (!this.api) return () => {};

    return this.api.onInstanceOutput((output) => {
      this.ngZone.run(() => callback(output));
    });
  }

  /**
   * Subscribe to batch updates
   */
  onBatchUpdate(callback: (batch: unknown) => void): () => void {
    if (!this.api) return () => {};

    return this.api.onBatchUpdate((batch) => {
      this.ngZone.run(() => callback(batch));
    });
  }

  // ============================================
  // App
  // ============================================

  /**
   * Signal app ready
   */
  async appReady() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.appReady();
  }

  /**
   * Get app version
   */
  async getVersion(): Promise<string> {
    if (!this.api) return '0.0.0-browser';
    const response = await this.api.getVersion();
    return response.success ? (response.data as string) : '0.0.0';
  }

  // ============================================
  // CLI Detection
  // ============================================

  /**
   * Detect all available CLIs
   */
  async detectClis() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.detectClis();
  }

  /**
   * Check if a specific CLI is available
   */
  async checkCli(cliType: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.checkCli(cliType);
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
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.listHistory(options);
  }

  /**
   * Load full conversation data for a history entry
   */
  async loadHistoryEntry(entryId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.loadHistoryEntry(entryId);
  }

  /**
   * Delete a history entry
   */
  async deleteHistoryEntry(entryId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.deleteHistoryEntry(entryId);
  }

  /**
   * Restore a conversation from history as a new instance
   */
  async restoreHistory(entryId: string, workingDirectory?: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.restoreHistory(entryId, workingDirectory);
  }

  /**
   * Clear all history
   */
  async clearHistory() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.clearHistory();
  }
}
