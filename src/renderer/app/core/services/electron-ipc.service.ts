/**
 * Electron IPC Service - Bridge between Angular and Electron main process
 */

import { Injectable, NgZone, inject } from '@angular/core';
import type { ElectronAPI } from '../../../../preload/preload';
import type { TodoList } from '../../../../shared/types/todo.types';

/** File entry from directory listing */
export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAt: number;
  createdAt?: number;
  extension?: string;
}

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

  /**
   * Generic invoke method for IPC calls
   * Use this for custom/dynamic IPC channels
   */
  async invoke<T = unknown>(channel: string, payload?: unknown): Promise<{ success: boolean; data?: T; error?: { message: string } }> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };

    // Use the underlying ipcRenderer.invoke via preload
    if ((this.api as Record<string, unknown>)['invoke']) {
      return (this.api as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)['invoke'](channel, payload) as Promise<{ success: boolean; data?: T; error?: { message: string } }>;
    }

    // Fallback: map to specific method if available
    console.warn(`No invoke method available, channel: ${channel}`);
    return { success: false, error: { message: `Channel not supported: ${channel}` } };
  }

  /**
   * Generic event listener for IPC events
   */
  on(channel: string, callback: (data: unknown) => void): () => void {
    if (!this.api) return () => {};

    if ((this.api as Record<string, unknown>)['on']) {
      return (this.api as unknown as Record<string, (...args: unknown[]) => () => void>)['on'](channel, (data: unknown) => {
        this.ngZone.run(() => callback(data));
      });
    }

    console.warn(`No on method available, channel: ${channel}`);
    return () => {};
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
    agentId?: string;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.createInstance(config);
  }

  /**
   * Create a new instance and immediately send a message
   */
  async createInstanceWithMessage(config: {
    workingDirectory: string;
    message: string;
    attachments?: any[];
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.createInstanceWithMessage(config);
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
   * Interrupt an instance (Ctrl+C equivalent)
   * Sends SIGINT to pause current operation without terminating
   */
  async interruptInstance(instanceId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.interruptInstance({ instanceId });
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
   * Detect a single CLI by command
   */
  async detectOneCli(command: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.detectOneCli(command);
  }

  /**
   * Check if a specific CLI is available
   */
  async checkCli(cliType: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.checkCli(cliType);
  }

  /**
   * Test connection to a CLI
   */
  async testCliConnection(command: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.testCliConnection(command);
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

  // ============================================
  // Providers
  // ============================================

  /**
   * List all provider configurations
   */
  async listProviders() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.listProviders();
  }

  /**
   * Get status of a specific provider
   */
  async getProviderStatus(providerType: string, forceRefresh?: boolean) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.getProviderStatus(providerType, forceRefresh);
  }

  /**
   * Get status of all providers
   */
  async getAllProviderStatus() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.getAllProviderStatus();
  }

  /**
   * Update provider configuration
   */
  async updateProviderConfig(providerType: string, config: Record<string, unknown>) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.updateProviderConfig(providerType, config);
  }

  // ============================================
  // Session Operations
  // ============================================

  /**
   * Fork a session at a specific message point
   */
  async forkSession(instanceId: string, atMessageIndex?: number, displayName?: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.forkSession({ instanceId, atMessageIndex, displayName });
  }

  /**
   * Export a session to JSON or Markdown
   */
  async exportSession(instanceId: string, format: 'json' | 'markdown') {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.exportSession({ instanceId, format });
  }

  /**
   * Import a session from a file
   */
  async importSession(filePath: string, workingDirectory?: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.importSession({ filePath, workingDirectory });
  }

  /**
   * Copy session to clipboard
   */
  async copySessionToClipboard(instanceId: string, format: 'json' | 'markdown') {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.copySessionToClipboard({ instanceId, format });
  }

  /**
   * Save session to file
   */
  async saveSessionToFile(instanceId: string, format: 'json' | 'markdown', filePath?: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.saveSessionToFile({ instanceId, format, filePath });
  }

  /**
   * Reveal a file in the system file manager
   */
  async revealFile(filePath: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.revealFile(filePath);
  }

  // ============================================
  // Command Operations
  // ============================================

  /**
   * List all commands (built-in + custom)
   */
  async listCommands() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.listCommands();
  }

  /**
   * Execute a command
   */
  async executeCommand(commandId: string, instanceId: string, args?: string[]) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.executeCommand({ commandId, instanceId, args });
  }

  /**
   * Create a custom command
   */
  async createCommand(config: {
    name: string;
    description: string;
    template: string;
    hint?: string;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.createCommand(config);
  }

  /**
   * Update a custom command
   */
  async updateCommand(commandId: string, updates: Partial<{
    name: string;
    description: string;
    template: string;
    hint: string;
  }>) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.updateCommand({ commandId, updates });
  }

  /**
   * Delete a custom command
   */
  async deleteCommand(commandId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.deleteCommand(commandId);
  }

  // ============================================
  // Configuration (Hierarchical)
  // ============================================

  /**
   * Resolve configuration for a working directory
   * Returns merged config with source tracking (project > user > default)
   */
  async resolveConfig(workingDirectory?: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.resolveConfig(workingDirectory);
  }

  /**
   * Get project config from a specific path
   */
  async getProjectConfig(configPath: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.getProjectConfig(configPath);
  }

  /**
   * Save project config to a specific path
   */
  async saveProjectConfig(configPath: string, config: Record<string, unknown>) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.saveProjectConfig(configPath, config);
  }

  /**
   * Create a new project config file
   */
  async createProjectConfig(projectDir: string, config?: Record<string, unknown>) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.createProjectConfig(projectDir, config);
  }

  /**
   * Find project config path by searching up the directory tree
   */
  async findProjectConfig(startDir: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.findProjectConfig(startDir);
  }

  // ============================================
  // Plan Mode
  // ============================================

  /**
   * Enter plan mode (read-only exploration)
   */
  async enterPlanMode(instanceId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.enterPlanMode(instanceId);
  }

  /**
   * Exit plan mode
   */
  async exitPlanMode(instanceId: string, force?: boolean) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.exitPlanMode(instanceId, force);
  }

  /**
   * Approve a plan (allows transition to implementation)
   */
  async approvePlan(instanceId: string, planContent?: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.approvePlan(instanceId, planContent);
  }

  /**
   * Update plan content
   */
  async updatePlanContent(instanceId: string, planContent: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.updatePlanContent(instanceId, planContent);
  }

  /**
   * Get plan mode state
   */
  async getPlanModeState(instanceId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.getPlanModeState(instanceId);
  }

  // ============================================
  // VCS (Git) Operations
  // ============================================

  /**
   * Check if working directory is a git repository
   */
  async vcsIsRepo(workingDirectory: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsIsRepo(workingDirectory);
  }

  /**
   * Get git status for working directory
   */
  async vcsGetStatus(workingDirectory: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsGetStatus(workingDirectory);
  }

  /**
   * Get branches for working directory
   */
  async vcsGetBranches(workingDirectory: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsGetBranches(workingDirectory);
  }

  /**
   * Get recent commits
   */
  async vcsGetCommits(workingDirectory: string, limit?: number) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsGetCommits(workingDirectory, limit);
  }

  /**
   * Get diff (staged, unstaged, or between refs)
   */
  async vcsGetDiff(payload: {
    workingDirectory: string;
    type: 'staged' | 'unstaged' | 'between';
    fromRef?: string;
    toRef?: string;
    filePath?: string;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsGetDiff(payload);
  }

  /**
   * Get file history (commits that modified the file)
   */
  async vcsGetFileHistory(workingDirectory: string, filePath: string, limit?: number) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsGetFileHistory(workingDirectory, filePath, limit);
  }

  /**
   * Get file content at a specific commit
   */
  async vcsGetFileAtCommit(workingDirectory: string, filePath: string, commitHash: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsGetFileAtCommit(workingDirectory, filePath, commitHash);
  }

  /**
   * Get blame information for a file
   */
  async vcsGetBlame(workingDirectory: string, filePath: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsGetBlame(workingDirectory, filePath);
  }

  // ============================================
  // Snapshot Operations (File Revert)
  // ============================================

  /**
   * Take a snapshot before file modification
   */
  async snapshotTake(payload: {
    filePath: string;
    instanceId: string;
    sessionId?: string;
    action?: 'create' | 'modify' | 'delete';
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.snapshotTake(payload);
  }

  /**
   * Start a snapshot session
   */
  async snapshotStartSession(instanceId: string, description?: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.snapshotStartSession(instanceId, description);
  }

  /**
   * End a snapshot session
   */
  async snapshotEndSession(sessionId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.snapshotEndSession(sessionId);
  }

  /**
   * Get all snapshots for an instance
   */
  async snapshotGetForInstance(instanceId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.snapshotGetForInstance(instanceId);
  }

  /**
   * Get all snapshots for a file
   */
  async snapshotGetForFile(filePath: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.snapshotGetForFile(filePath);
  }

  /**
   * Get all sessions for an instance
   */
  async snapshotGetSessions(instanceId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.snapshotGetSessions(instanceId);
  }

  /**
   * Get content from a snapshot
   */
  async snapshotGetContent(snapshotId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.snapshotGetContent(snapshotId);
  }

  /**
   * Revert a file to a specific snapshot
   */
  async snapshotRevertFile(snapshotId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.snapshotRevertFile(snapshotId);
  }

  /**
   * Revert all files in a session
   */
  async snapshotRevertSession(sessionId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.snapshotRevertSession(sessionId);
  }

  /**
   * Get diff between snapshot and current file
   */
  async snapshotGetDiff(snapshotId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.snapshotGetDiff(snapshotId);
  }

  /**
   * Delete a snapshot
   */
  async snapshotDelete(snapshotId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.snapshotDelete(snapshotId);
  }

  /**
   * Cleanup old snapshots
   */
  async snapshotCleanup(maxAgeDays?: number) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.snapshotCleanup(maxAgeDays);
  }

  /**
   * Get snapshot storage stats
   */
  async snapshotGetStats() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.snapshotGetStats();
  }

  // ============================================
  // TODO Operations
  // ============================================

  /**
   * Get TODO list for a session
   */
  async todoGetList(sessionId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.todoGetList(sessionId);
  }

  /**
   * Create a new TODO
   */
  async todoCreate(payload: {
    sessionId: string;
    content: string;
    activeForm?: string;
    priority?: 'low' | 'medium' | 'high' | 'critical';
    parentId?: string;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.todoCreate(payload);
  }

  /**
   * Update a TODO
   */
  async todoUpdate(payload: {
    sessionId: string;
    todoId: string;
    content?: string;
    activeForm?: string;
    status?: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    priority?: 'low' | 'medium' | 'high' | 'critical';
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.todoUpdate(payload);
  }

  /**
   * Delete a TODO
   */
  async todoDelete(sessionId: string, todoId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.todoDelete(sessionId, todoId);
  }

  /**
   * Write all TODOs at once (replaces existing)
   * This matches Claude's TodoWrite tool format
   */
  async todoWriteAll(payload: {
    sessionId: string;
    todos: Array<{
      content: string;
      status: string;
      activeForm?: string;
    }>;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.todoWriteAll(payload);
  }

  /**
   * Clear all TODOs for a session
   */
  async todoClear(sessionId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.todoClear(sessionId);
  }

  /**
   * Get the current in-progress TODO
   */
  async todoGetCurrent(sessionId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.todoGetCurrent(sessionId);
  }

  /**
   * Subscribe to TODO list changes
   */
  onTodoListChanged(callback: (data: { sessionId: string; list: TodoList }) => void): () => void {
    if (!this.api) return () => {};

    return this.api.onTodoListChanged((data) => {
      this.ngZone.run(() => callback(data as { sessionId: string; list: TodoList }));
    });
  }

  // ============================================
  // MCP Operations
  // ============================================

  /**
   * Get full MCP state (servers, tools, resources, prompts)
   */
  async mcpGetState() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpGetState();
  }

  /**
   * Get all MCP servers
   */
  async mcpGetServers() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpGetServers();
  }

  /**
   * Add an MCP server
   */
  async mcpAddServer(payload: {
    id: string;
    name: string;
    description?: string;
    transport: 'stdio' | 'http' | 'sse';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    autoConnect?: boolean;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpAddServer(payload);
  }

  /**
   * Remove an MCP server
   */
  async mcpRemoveServer(serverId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpRemoveServer(serverId);
  }

  /**
   * Connect to an MCP server
   */
  async mcpConnect(serverId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpConnect(serverId);
  }

  /**
   * Disconnect from an MCP server
   */
  async mcpDisconnect(serverId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpDisconnect(serverId);
  }

  /**
   * Restart an MCP server connection
   */
  async mcpRestart(serverId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpRestart(serverId);
  }

  /**
   * Get all MCP tools
   */
  async mcpGetTools() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpGetTools();
  }

  /**
   * Get all MCP resources
   */
  async mcpGetResources() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpGetResources();
  }

  /**
   * Get all MCP prompts
   */
  async mcpGetPrompts() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpGetPrompts();
  }

  /**
   * Call an MCP tool
   */
  async mcpCallTool(payload: {
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpCallTool(payload);
  }

  /**
   * Read an MCP resource
   */
  async mcpReadResource(payload: {
    serverId: string;
    uri: string;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpReadResource(payload);
  }

  /**
   * Get an MCP prompt
   */
  async mcpGetPrompt(payload: {
    serverId: string;
    promptName: string;
    arguments?: Record<string, string>;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpGetPrompt(payload);
  }

  /**
   * Get MCP server presets
   */
  async mcpGetPresets() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpGetPresets();
  }

  /**
   * Subscribe to MCP state changes (tools, resources, prompts updated)
   */
  onMcpStateChanged(callback: (data: { type: string; serverId?: string }) => void): () => void {
    if (!this.api) return () => {};

    return this.api.onMcpStateChanged((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  /**
   * Subscribe to MCP server status changes
   */
  onMcpServerStatusChanged(callback: (data: { serverId: string; status: string; error?: string }) => void): () => void {
    if (!this.api) return () => {};

    return this.api.onMcpServerStatusChanged((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  // ============================================
  // LSP Operations
  // ============================================

  /**
   * Get available LSP servers (installed language servers)
   */
  async lspGetAvailableServers() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.lspGetAvailableServers();
  }

  /**
   * Get status of all active LSP clients
   */
  async lspGetStatus() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.lspGetStatus();
  }

  /**
   * Go to definition (navigate to where symbol is defined)
   */
  async lspGoToDefinition(filePath: string, line: number, character: number) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.lspGoToDefinition({ filePath, line, character });
  }

  /**
   * Find all references to a symbol
   */
  async lspFindReferences(filePath: string, line: number, character: number, includeDeclaration = true) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.lspFindReferences({ filePath, line, character, includeDeclaration });
  }

  /**
   * Get hover information (type info, documentation)
   */
  async lspHover(filePath: string, line: number, character: number) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.lspHover({ filePath, line, character });
  }

  /**
   * Get document symbols (outline/structure)
   */
  async lspDocumentSymbols(filePath: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.lspDocumentSymbols(filePath);
  }

  /**
   * Search workspace symbols
   */
  async lspWorkspaceSymbols(query: string, rootPath: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.lspWorkspaceSymbols(query, rootPath);
  }

  /**
   * Get diagnostics (errors, warnings) for a file
   */
  async lspDiagnostics(filePath: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.lspDiagnostics(filePath);
  }

  /**
   * Check if LSP is available for a file type
   */
  async lspIsAvailable(filePath: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.lspIsAvailable(filePath);
  }

  /**
   * Shutdown all LSP clients
   */
  async lspShutdown() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.lspShutdown();
  }

  // ============================================
  // Multi-Edit Operations
  // ============================================

  /**
   * Preview edits without applying them
   * Returns what would happen if edits were applied
   */
  async multiEditPreview(edits: Array<{
    filePath: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  }>) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.multiEditPreview({ edits });
  }

  /**
   * Apply edits atomically (all succeed or all fail)
   * Optionally takes snapshots before modifications
   */
  async multiEditApply(
    edits: Array<{
      filePath: string;
      oldString: string;
      newString: string;
      replaceAll?: boolean;
    }>,
    options: {
      instanceId?: string;
      takeSnapshots?: boolean;
    } = {}
  ) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.multiEditApply({
      edits,
      instanceId: options.instanceId,
      takeSnapshots: options.takeSnapshots,
    });
  }

  // ============================================
  // Bash Validation
  // ============================================

  /**
   * Validate a bash command for safety
   * Returns risk level and any warnings/blocks
   */
  async bashValidate(command: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.bashValidate(command);
  }

  /**
   * Get bash validator configuration
   */
  async bashGetConfig() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.bashGetConfig();
  }

  /**
   * Add a command to the allowed list
   */
  async bashAddAllowed(command: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.bashAddAllowed(command);
  }

  /**
   * Add a command to the blocked list
   */
  async bashAddBlocked(command: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.bashAddBlocked(command);
  }

  // ============================================
  // Task Management (Subagent Spawning)
  // ============================================

  /**
   * Get task status by ID
   */
  async taskGetStatus(taskId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.taskGetStatus(taskId);
  }

  /**
   * Get task history
   */
  async taskGetHistory(parentId?: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.taskGetHistory(parentId);
  }

  /**
   * Get tasks by parent instance
   */
  async taskGetByParent(parentId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.taskGetByParent(parentId);
  }

  /**
   * Get task by child instance
   */
  async taskGetByChild(childId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.taskGetByChild(childId);
  }

  /**
   * Cancel a task
   */
  async taskCancel(taskId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.taskCancel(taskId);
  }

  /**
   * Get task queue stats
   */
  async taskGetQueue() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.taskGetQueue();
  }

  // ============================================
  // Security - Secret Detection & Redaction
  // ============================================

  /**
   * Detect secrets in content
   */
  async securityDetectSecrets(content: string, contentType?: 'env' | 'text' | 'auto') {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.securityDetectSecrets(content, contentType);
  }

  /**
   * Redact secrets in content
   */
  async securityRedactContent(
    content: string,
    contentType?: 'env' | 'text' | 'auto',
    options?: { maskChar?: string; showStart?: number; showEnd?: number; fullMask?: boolean; label?: string }
  ) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.securityRedactContent(content, contentType, options);
  }

  /**
   * Check if a file path is sensitive
   */
  async securityCheckFile(filePath: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.securityCheckFile(filePath);
  }

  /**
   * Get secret access audit log
   */
  async securityGetAuditLog(instanceId?: string, limit?: number) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.securityGetAuditLog(instanceId, limit);
  }

  /**
   * Clear audit log
   */
  async securityClearAuditLog() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.securityClearAuditLog();
  }

  /**
   * Get safe environment variables
   */
  async securityGetSafeEnv() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.securityGetSafeEnv();
  }

  /**
   * Check if a single env var should be allowed
   */
  async securityCheckEnvVar(name: string, value: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.securityCheckEnvVar(name, value);
  }

  /**
   * Get env filter config
   */
  async securityGetEnvFilterConfig() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.securityGetEnvFilterConfig();
  }

  // ============================================
  // Cost Tracking (5.3)
  // ============================================

  /**
   * Record token usage and cost
   */
  async costRecordUsage(
    instanceId: string,
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number
  ) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.costRecordUsage(instanceId, provider, model, inputTokens, outputTokens);
  }

  /**
   * Get cost summary
   */
  async costGetSummary(instanceId?: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.costGetSummary(instanceId);
  }

  /**
   * Get cost history
   */
  async costGetHistory(instanceId?: string, limit?: number) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.costGetHistory(instanceId, limit);
  }

  /**
   * Set budget limits
   */
  async costSetBudget(budget: {
    daily?: number;
    weekly?: number;
    monthly?: number;
    warningThreshold?: number;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.costSetBudget(budget);
  }

  /**
   * Get current budget status
   */
  async costGetBudgetStatus() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.costGetBudgetStatus();
  }

  /**
   * Listen for cost usage events
   */
  onCostUsageRecorded(callback: (data: any) => void): () => void {
    if (!this.api) return () => {};
    return this.api.onCostUsageRecorded((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  /**
   * Listen for budget warning events
   */
  onCostBudgetWarning(callback: (data: any) => void): () => void {
    if (!this.api) return () => {};
    return this.api.onCostBudgetWarning((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  /**
   * Listen for budget exceeded events
   */
  onCostBudgetExceeded(callback: (data: any) => void): () => void {
    if (!this.api) return () => {};
    return this.api.onCostBudgetExceeded((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  // ============================================
  // Session Archive (1.3)
  // ============================================

  /**
   * Archive a session
   */
  async archiveSession(
    sessionId: string,
    sessionData: any,
    options?: { compress?: boolean; metadata?: Record<string, any> }
  ) {
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
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.archiveList(filter);
  }

  /**
   * Restore archive
   */
  async archiveRestore(archiveId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.archiveRestore(archiveId);
  }

  /**
   * Delete archive
   */
  async archiveDelete(archiveId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.archiveDelete(archiveId);
  }

  /**
   * Search archives
   */
  async archiveSearch(query: string, options?: { limit?: number; fields?: string[] }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.archiveSearch(query, options);
  }

  // ============================================
  // Remote Config (6.2)
  // ============================================

  /**
   * Fetch remote config
   */
  async remoteConfigFetch(force?: boolean) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.remoteConfigFetch(force);
  }

  /**
   * Get config value
   */
  async remoteConfigGet(key: string, defaultValue?: any) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.remoteConfigGet(key, defaultValue);
  }

  /**
   * Set config source
   */
  async remoteConfigSetSource(source: {
    type: 'url' | 'file' | 'git';
    location: string;
    refreshInterval?: number;
    branch?: string;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.remoteConfigSetSource(source);
  }

  /**
   * Get config status
   */
  async remoteConfigStatus() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.remoteConfigStatus();
  }

  /**
   * Listen for remote config updates
   */
  onRemoteConfigUpdated(callback: (config: any) => void): () => void {
    if (!this.api) return () => {};
    return this.api.onRemoteConfigUpdated((config) => {
      this.ngZone.run(() => callback(config));
    });
  }

  /**
   * Listen for remote config errors
   */
  onRemoteConfigError(callback: (error: any) => void): () => void {
    if (!this.api) return () => {};
    return this.api.onRemoteConfigError((error) => {
      this.ngZone.run(() => callback(error));
    });
  }

  // ============================================
  // External Editor (9.2)
  // ============================================

  /**
   * Open file in external editor
   */
  async editorOpen(
    filePath: string,
    options?: { editor?: string; line?: number; column?: number; waitForClose?: boolean }
  ) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.editorOpen(filePath, options);
  }

  /**
   * Get available editors
   */
  async editorGetAvailable() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.editorGetAvailable();
  }

  /**
   * Set default editor
   */
  async editorSetDefault(editorId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.editorSetDefault(editorId);
  }

  /**
   * Get default editor
   */
  async editorGetDefault() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.editorGetDefault();
  }

  // ============================================
  // File Watcher (10.1)
  // ============================================

  /**
   * Watch a path for changes
   */
  async watcherWatch(
    path: string,
    options?: { recursive?: boolean; patterns?: string[]; ignorePatterns?: string[]; debounceMs?: number }
  ) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.watcherWatch(path, options);
  }

  /**
   * Stop watching a path
   */
  async watcherUnwatch(watcherId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.watcherUnwatch(watcherId);
  }

  /**
   * Get active watchers
   */
  async watcherGetActive() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.watcherGetActive();
  }

  /**
   * Listen for file change events
   */
  onWatcherFileChanged(callback: (data: any) => void): () => void {
    if (!this.api) return () => {};
    return this.api.onWatcherFileChanged((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  /**
   * Listen for file added events
   */
  onWatcherFileAdded(callback: (data: any) => void): () => void {
    if (!this.api) return () => {};
    return this.api.onWatcherFileAdded((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  /**
   * Listen for file removed events
   */
  onWatcherFileRemoved(callback: (data: any) => void): () => void {
    if (!this.api) return () => {};
    return this.api.onWatcherFileRemoved((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  /**
   * Listen for watcher errors
   */
  onWatcherError(callback: (data: any) => void): () => void {
    if (!this.api) return () => {};
    return this.api.onWatcherError((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  // ============================================
  // Logging (13.1)
  // ============================================

  /**
   * Log a message
   */
  async logMessage(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    context?: string,
    metadata?: Record<string, any>
  ) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.logMessage(level, message, context, metadata);
  }

  /**
   * Get logs
   */
  async logGetLogs(options?: {
    level?: 'debug' | 'info' | 'warn' | 'error';
    context?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.logGetLogs(options);
  }

  /**
   * Set log level
   */
  async logSetLevel(level: 'debug' | 'info' | 'warn' | 'error') {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.logSetLevel(level);
  }

  /**
   * Export logs
   */
  async logExport(filePath: string, options?: { format?: 'json' | 'csv'; compress?: boolean }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.logExport(filePath, options);
  }

  /**
   * Clear logs
   */
  async logClear() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.logClear();
  }

  // ============================================
  // Debug Commands (13.2)
  // ============================================

  /**
   * Execute debug command
   */
  async debugExecute(command: string, args?: Record<string, any>) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.debugExecute(command, args);
  }

  /**
   * Get available debug commands
   */
  async debugGetCommands() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.debugGetCommands();
  }

  /**
   * Get debug info
   */
  async debugGetInfo() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.debugGetInfo();
  }

  /**
   * Run diagnostics
   */
  async debugRunDiagnostics() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.debugRunDiagnostics();
  }

  // ============================================
  // Usage Stats (14.1)
  // ============================================

  /**
   * Record session start
   */
  async statsRecordSessionStart(
    sessionId: string,
    instanceId: string,
    agentId: string,
    workingDirectory: string
  ) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.statsRecordSessionStart(sessionId, instanceId, agentId, workingDirectory);
  }

  /**
   * Record session end
   */
  async statsRecordSessionEnd(sessionId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.statsRecordSessionEnd(sessionId);
  }

  /**
   * Record message stats
   */
  async statsRecordMessage(
    sessionId: string,
    inputTokens: number,
    outputTokens: number,
    cost: number
  ) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.statsRecordMessage(sessionId, inputTokens, outputTokens, cost);
  }

  /**
   * Record tool usage
   */
  async statsRecordToolUsage(sessionId: string, tool: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.statsRecordToolUsage(sessionId, tool);
  }

  /**
   * Get stats for a period
   */
  async statsGetStats(period: 'day' | 'week' | 'month' | 'year' | 'all') {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.statsGetStats(period);
  }

  /**
   * Export stats
   */
  async statsExport(filePath: string, period?: 'day' | 'week' | 'month' | 'year' | 'all') {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.statsExport(filePath, period);
  }

  // ============================================
  // Semantic Search (4.7)
  // ============================================

  /**
   * Perform semantic search
   */
  async searchSemantic(options: {
    query: string;
    directory: string;
    maxResults?: number;
    includePatterns?: string[];
    excludePatterns?: string[];
    searchType?: 'semantic' | 'hybrid' | 'keyword';
    minScore?: number;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.searchSemantic(options);
  }

  /**
   * Build search index
   */
  async searchBuildIndex(
    directory: string,
    includePatterns?: string[],
    excludePatterns?: string[]
  ) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.searchBuildIndex(directory, includePatterns, excludePatterns);
  }

  /**
   * Configure Exa API for enhanced search
   */
  async searchConfigureExa(config: { apiKey: string; baseUrl?: string }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.searchConfigureExa(config);
  }

  /**
   * Get search index stats
   */
  async searchGetIndexStats() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.searchGetIndexStats();
  }

  // ============================================
  // Provider Plugins (12.2)
  // ============================================

  /**
   * Discover available plugins
   */
  async pluginsDiscover() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pluginsDiscover();
  }

  /**
   * Load a plugin
   */
  async pluginsLoad(pluginId: string, options?: { timeout?: number; sandbox?: boolean }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pluginsLoad(pluginId, options);
  }

  /**
   * Unload a plugin
   */
  async pluginsUnload(pluginId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pluginsUnload(pluginId);
  }

  /**
   * Install a plugin from file
   */
  async pluginsInstall(sourcePath: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pluginsInstall(sourcePath);
  }

  /**
   * Uninstall a plugin
   */
  async pluginsUninstall(pluginId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pluginsUninstall(pluginId);
  }

  /**
   * Get loaded plugins
   */
  async pluginsGetLoaded() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pluginsGetLoaded();
  }

  /**
   * Create a plugin template
   */
  async pluginsCreateTemplate(name: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.pluginsCreateTemplate(name);
  }

  /**
   * Listen for plugin loaded events
   */
  onPluginLoaded(callback: (data: { pluginId: string }) => void): () => void {
    if (!this.api) return () => {};
    return this.api.onPluginLoaded((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  /**
   * Listen for plugin unloaded events
   */
  onPluginUnloaded(callback: (data: { pluginId: string }) => void): () => void {
    if (!this.api) return () => {};
    return this.api.onPluginUnloaded((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  /**
   * Listen for plugin error events
   */
  onPluginError(callback: (data: { pluginId: string; error: string }) => void): () => void {
    if (!this.api) return () => {};
    return this.api.onPluginError((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  // ============================================
  // Phase 6: Workflows (6.1)
  // ============================================

  /**
   * List available workflow templates
   */
  async workflowListTemplates() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.workflowListTemplates();
  }

  /**
   * Get a specific workflow template
   */
  async workflowGetTemplate(templateId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.workflowGetTemplate(templateId);
  }

  /**
   * Start a workflow
   */
  async workflowStart(payload: {
    instanceId: string;
    templateId: string;
    config?: Record<string, unknown>;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.workflowStart(payload);
  }

  /**
   * Get workflow execution status
   */
  async workflowGetExecution(executionId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.workflowGetExecution(executionId);
  }

  /**
   * Get workflow execution for instance
   */
  async workflowGetByInstance(instanceId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.workflowGetByInstance(instanceId);
  }

  /**
   * Complete a workflow phase
   */
  async workflowCompletePhase(executionId: string, phaseId: string, result?: unknown) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.workflowCompletePhase(executionId, phaseId, result);
  }

  /**
   * Satisfy a workflow gate
   */
  async workflowSatisfyGate(executionId: string, gateId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.workflowSatisfyGate(executionId, gateId);
  }

  /**
   * Skip a workflow phase
   */
  async workflowSkipPhase(executionId: string, phaseId: string, reason?: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.workflowSkipPhase(executionId, phaseId, reason);
  }

  /**
   * Cancel a workflow
   */
  async workflowCancel(executionId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.workflowCancel(executionId);
  }

  /**
   * Get workflow prompt addition
   */
  async workflowGetPromptAddition(executionId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.workflowGetPromptAddition(executionId);
  }

  // ============================================
  // Phase 6: Review Agents (6.2)
  // ============================================

  /**
   * List available review agents
   */
  async reviewListAgents() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.reviewListAgents();
  }

  /**
   * Get a specific review agent
   */
  async reviewGetAgent(agentId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.reviewGetAgent(agentId);
  }

  // ============================================
  // Phase 6: Hooks (6.3)
  // ============================================

  /**
   * List hooks
   */
  async hooksList(filter?: { event?: string; scope?: string }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.hooksList(filter);
  }

  /**
   * Get a hook by ID
   */
  async hooksGet(hookId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.hooksGet(hookId);
  }

  /**
   * Create a new hook
   */
  async hooksCreate(payload: {
    name: string;
    event: string;
    command: string;
    conditions?: Record<string, unknown>;
    scope?: 'global' | 'project';
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.hooksCreate(payload);
  }

  /**
   * Update a hook
   */
  async hooksUpdate(hookId: string, updates: Record<string, unknown>) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.hooksUpdate(hookId, updates);
  }

  /**
   * Delete a hook
   */
  async hooksDelete(hookId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.hooksDelete(hookId);
  }

  /**
   * Evaluate hooks for an event
   */
  async hooksEvaluate(event: string, context: Record<string, unknown>) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.hooksEvaluate(event, context);
  }

  /**
   * Import hooks from file
   */
  async hooksImport(filePath: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.hooksImport(filePath);
  }

  /**
   * Export hooks to file
   */
  async hooksExport(filePath: string, hookIds?: string[]) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.hooksExport(filePath, hookIds);
  }

  // ============================================
  // Phase 6: Skills (6.4)
  // ============================================

  /**
   * Discover skills in a directory
   */
  async skillsDiscover(directory?: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.skillsDiscover(directory);
  }

  /**
   * List available skills
   */
  async skillsList() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.skillsList();
  }

  /**
   * Get a skill by ID
   */
  async skillsGet(skillId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.skillsGet(skillId);
  }

  /**
   * Load a skill
   */
  async skillsLoad(skillId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.skillsLoad(skillId);
  }

  /**
   * Unload a skill
   */
  async skillsUnload(skillId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.skillsUnload(skillId);
  }

  /**
   * Load reference documentation for a skill
   */
  async skillsLoadReference(skillId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.skillsLoadReference(skillId);
  }

  /**
   * Load example for a skill
   */
  async skillsLoadExample(skillId: string, exampleId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.skillsLoadExample(skillId, exampleId);
  }

  /**
   * Match skills to a query
   */
  async skillsMatch(query: string, maxResults?: number) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.skillsMatch(query, maxResults);
  }

  /**
   * Get skill memory
   */
  async skillsGetMemory(skillId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.skillsGetMemory(skillId);
  }

  // ============================================
  // Phase 7: Worktrees (7.1)
  // ============================================

  /**
   * Create a worktree for isolated work
   */
  async worktreeCreate(payload: {
    instanceId: string;
    baseBranch?: string;
    branchName?: string;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.worktreeCreate(payload);
  }

  /**
   * List worktrees
   */
  async worktreeList(instanceId?: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.worktreeList(instanceId);
  }

  /**
   * Delete a worktree
   */
  async worktreeDelete(worktreeId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.worktreeDelete(worktreeId);
  }

  /**
   * Get worktree status
   */
  async worktreeGetStatus(worktreeId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.worktreeGetStatus(worktreeId);
  }

  // ============================================
  // Phase 7: Specialists (7.4)
  // ============================================

  /**
   * List all specialist profiles
   */
  async specialistList() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistList();
  }

  /**
   * List built-in specialist profiles
   */
  async specialistListBuiltin() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistListBuiltin();
  }

  /**
   * List custom specialist profiles
   */
  async specialistListCustom() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistListCustom();
  }

  /**
   * Get a specialist profile
   */
  async specialistGet(profileId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistGet(profileId);
  }

  /**
   * Get specialist profiles by category
   */
  async specialistGetByCategory(category: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistGetByCategory(category);
  }

  /**
   * Add a custom specialist profile
   */
  async specialistAddCustom(profile: {
    id: string;
    name: string;
    description: string;
    category: string;
    icon: string;
    color: string;
    systemPromptAddition: string;
    restrictedTools: string[];
    constraints?: {
      readOnlyMode?: boolean;
      maxTokens?: number;
      allowedDirectories?: string[];
      blockedDirectories?: string[];
      requireApprovalFor?: string[];
    };
    tags?: string[];
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistAddCustom(profile);
  }

  /**
   * Update a custom specialist profile
   */
  async specialistUpdateCustom(profileId: string, updates: {
    name?: string;
    description?: string;
    category?: string;
    icon?: string;
    color?: string;
    systemPromptAddition?: string;
    restrictedTools?: string[];
    constraints?: {
      readOnlyMode?: boolean;
      maxTokens?: number;
      allowedDirectories?: string[];
      blockedDirectories?: string[];
      requireApprovalFor?: string[];
    };
    tags?: string[];
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistUpdateCustom(profileId, updates);
  }

  /**
   * Remove a custom specialist profile
   */
  async specialistRemoveCustom(profileId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistRemoveCustom(profileId);
  }

  /**
   * Get specialist recommendations based on context
   */
  async specialistRecommend(context: {
    taskDescription?: string;
    fileTypes?: string[];
    userPreferences?: string[];
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistRecommend(context);
  }

  /**
   * Create a specialist instance
   */
  async specialistCreateInstance(profileId: string, orchestratorInstanceId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistCreateInstance(profileId, orchestratorInstanceId);
  }

  /**
   * Get a specialist instance
   */
  async specialistGetInstance(instanceId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistGetInstance(instanceId);
  }

  /**
   * Get all active specialist instances
   */
  async specialistGetActiveInstances() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistGetActiveInstances();
  }

  /**
   * Update specialist instance status
   */
  async specialistUpdateStatus(instanceId: string, status: 'active' | 'paused' | 'completed' | 'failed') {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistUpdateStatus(instanceId, status);
  }

  /**
   * Add a finding to a specialist instance
   */
  async specialistAddFinding(instanceId: string, finding: {
    id: string;
    type: string;
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    title: string;
    description: string;
    filePath?: string;
    lineRange?: { start: number; end: number };
    codeSnippet?: string;
    suggestion?: string;
    confidence: number;
    tags?: string[];
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistAddFinding(instanceId, finding);
  }

  /**
   * Update specialist instance metrics
   */
  async specialistUpdateMetrics(instanceId: string, updates: {
    filesAnalyzed?: number;
    linesAnalyzed?: number;
    findingsCount?: number;
    tokensUsed?: number;
    durationMs?: number;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistUpdateMetrics(instanceId, updates);
  }

  /**
   * Get system prompt addition for a specialist
   */
  async specialistGetPromptAddition(profileId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistGetPromptAddition(profileId);
  }

  // ============================================
  // Phase 7: Supervision (7.3)
  // ============================================

  /**
   * Get supervision tree
   */
  async supervisionGetTree(rootInstanceId?: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.supervisionGetTree(rootInstanceId);
  }

  /**
   * Get supervision health status
   */
  async supervisionGetHealth() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.supervisionGetHealth();
  }

  // ============================================
  // Phase 8: RLM Context (8.1)
  // ============================================

  /**
   * Create or fetch a context store
   */
  async rlmCreateStore(instanceId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmCreateStore(instanceId);
  }

  /**
   * Add a section to a context store
   */
  async rlmAddSection(payload: {
    storeId: string;
    type: 'file' | 'conversation' | 'tool_output' | 'external' | 'summary';
    name: string;
    content: string;
    metadata?: Record<string, unknown>;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmAddSection(payload);
  }

  /**
   * Remove a section from a context store
   */
  async rlmRemoveSection(payload: { storeId: string; sectionId: string }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmRemoveSection(payload);
  }

  /**
   * Get a context store
   */
  async rlmGetStore(storeId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmGetStore(storeId);
  }

  /**
   * List context stores
   */
  async rlmListStores() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmListStores();
  }

  /**
   * List sections in a store
   */
  async rlmListSections(storeId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmListSections(storeId);
  }

  /**
   * List active RLM sessions
   */
  async rlmListSessions() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmListSessions();
  }

  /**
   * Delete a context store
   */
  async rlmDeleteStore(storeId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmDeleteStore(storeId);
  }

  /**
   * Start an RLM session
   */
  async rlmStartSession(payload: { storeId: string; instanceId: string }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmStartSession(payload);
  }

  /**
   * End an RLM session
   */
  async rlmEndSession(sessionId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmEndSession(sessionId);
  }

  /**
   * Execute an RLM query
   */
  async rlmExecuteQuery(payload: {
    sessionId: string;
    query: { type: string; params: Record<string, unknown> };
    depth?: number;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmExecuteQuery(payload);
  }

  /**
   * Get an RLM session
   */
  async rlmGetSession(sessionId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmGetSession(sessionId);
  }

  /**
   * Get RLM store stats
   */
  async rlmGetStoreStats(storeId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmGetStoreStats(storeId);
  }

  /**
   * Get RLM session stats
   */
  async rlmGetSessionStats(sessionId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmGetSessionStats(sessionId);
  }

  /**
   * Configure RLM
   */
  async rlmConfigure(config: Record<string, unknown>) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmConfigure(config);
  }

  /**
   * Record task outcome for RLM
   */
  async rlmRecordOutcome(payload: {
    instanceId: string;
    taskType: string;
    taskDescription: string;
    prompt: string;
    context?: string;
    agentUsed: string;
    modelUsed: string;
    workflowUsed?: string;
    toolsUsed: Array<{ tool: string; count: number; avgDuration: number; errorCount: number }>;
    tokensUsed: number;
    duration: number;
    success: boolean;
    completionScore?: number;
    userSatisfaction?: number;
    errorType?: string;
    errorMessage?: string;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmRecordOutcome(payload);
  }

  /**
   * Get RLM learned patterns
   */
  async rlmGetPatterns(minSuccessRate?: number) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmGetPatterns(minSuccessRate);
  }

  /**
   * Get RLM strategy suggestions
   */
  async rlmGetStrategySuggestions(context: string, maxSuggestions?: number) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmGetStrategySuggestions(context, maxSuggestions);
  }

  // ============================================
  // Phase 8: Learning (8.2)
  // ============================================

  /**
   * Record learning outcome
   */
  async learningRecordOutcome(payload: {
    instanceId: string;
    taskType: string;
    taskDescription: string;
    prompt: string;
    context?: string;
    agentUsed: string;
    modelUsed: string;
    workflowUsed?: string;
    toolsUsed: Array<{ tool: string; count: number; avgDuration: number; errorCount: number }>;
    tokensUsed: number;
    duration: number;
    success: boolean;
    completionScore?: number;
    userSatisfaction?: number;
    errorType?: string;
    errorMessage?: string;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.learningRecordOutcome(payload);
  }

  /**
   * Get learning patterns
   */
  async learningGetPatterns(minSuccessRate?: number) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.learningGetPatterns(minSuccessRate);
  }

  /**
   * Get learning suggestions
   */
  async learningGetSuggestions(context: string, maxSuggestions?: number) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.learningGetSuggestions(context, maxSuggestions);
  }

  /**
   * Enhance prompt with learning
   */
  async learningEnhancePrompt(prompt: string, context: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.learningEnhancePrompt(prompt, context);
  }

  // ============================================
  // Phase 8: Verification (8.3)
  // ============================================

  /**
   * Verify with multiple models (API-based)
   */
  async verificationVerifyMulti(payload: {
    query: string;
    context?: string;
    models?: string[];
    consensusThreshold?: number;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.verificationVerifyMulti(payload);
  }

  /**
   * Start CLI-based verification
   */
  async verificationStartCli(payload: {
    id: string;
    prompt: string;
    context?: string;
    config: {
      cliAgents?: string[];
      agentCount?: number;
      synthesisStrategy?: string;
      personalities?: string[];
      confidenceThreshold?: number;
      timeout?: number;
      maxDebateRounds?: number;
      fallbackToApi?: boolean;
      mixedMode?: boolean;
    };
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.verificationStartCli(payload);
  }

  /**
   * Cancel an ongoing verification
   */
  async verificationCancel(verificationId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.verificationCancel({ id: verificationId });
  }

  /**
   * Get active verifications
   */
  async verificationGetActive() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.verificationGetActive();
  }

  /**
   * Get verification result
   */
  async verificationGetResult(verificationId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.verificationGetResult(verificationId);
  }

  // ============================================
  // Phase 9: Memory-R1 (9.1)
  // ============================================

  /**
   * Memory-R1: Decide what operation to perform
   */
  async memoryR1DecideOperation(payload: {
    context: string;
    candidateContent: string;
    taskId: string;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.memoryR1DecideOperation(payload);
  }

  /**
   * Memory-R1: Execute a decided operation
   */
  async memoryR1ExecuteOperation(decision: Record<string, unknown>) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.memoryR1ExecuteOperation(decision);
  }

  /**
   * Memory-R1: Add entry directly
   */
  async memoryR1AddEntry(payload: {
    content: string;
    reason: string;
    sourceType?: string;
    sourceSessionId?: string;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.memoryR1AddEntry(payload);
  }

  /**
   * Memory-R1: Delete entry
   */
  async memoryR1DeleteEntry(entryId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.memoryR1DeleteEntry(entryId);
  }

  /**
   * Memory-R1: Get entry
   */
  async memoryR1GetEntry(entryId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.memoryR1GetEntry(entryId);
  }

  /**
   * Memory-R1: Retrieve memories
   */
  async memoryR1Retrieve(payload: { query: string; taskId: string }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.memoryR1Retrieve(payload);
  }

  /**
   * Memory-R1: Record task outcome
   */
  async memoryR1RecordOutcome(payload: {
    taskId: string;
    success: boolean;
    score: number;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.memoryR1RecordOutcome(payload);
  }

  /**
   * Memory-R1: Get stats
   */
  async memoryR1GetStats() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.memoryR1GetStats();
  }

  /**
   * Memory-R1: Save state
   */
  async memoryR1Save() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.memoryR1Save();
  }

  /**
   * Memory-R1: Load state
   */
  async memoryR1Load(snapshot: Record<string, unknown>) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.memoryR1Load(snapshot);
  }

  /**
   * Memory-R1: Configure
   */
  async memoryR1Configure(config: Record<string, unknown>) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.memoryR1Configure(config);
  }

  // ============================================
  // Phase 9: Unified Memory (9.2)
  // ============================================

  /**
   * Unified Memory: Process input
   */
  async unifiedMemoryProcessInput(payload: {
    input: string;
    sessionId: string;
    taskId: string;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryProcessInput(payload);
  }

  /**
   * Unified Memory: Retrieve
   */
  async unifiedMemoryRetrieve(payload: {
    query: string;
    taskId: string;
    options?: { types?: string[]; maxTokens?: number };
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryRetrieve(payload);
  }

  /**
   * Unified Memory: Record session end
   */
  async unifiedMemoryRecordSessionEnd(payload: {
    sessionId: string;
    outcome: string;
    summary: string;
    lessons: string[];
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryRecordSessionEnd(payload);
  }

  /**
   * Unified Memory: Record workflow
   */
  async unifiedMemoryRecordWorkflow(payload: {
    name: string;
    steps: string[];
    applicableContexts: string[];
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryRecordWorkflow(payload);
  }

  /**
   * Unified Memory: Record strategy
   */
  async unifiedMemoryRecordStrategy(payload: {
    strategy: string;
    conditions: string[];
    taskId: string;
    success: boolean;
    score: number;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryRecordStrategy(payload);
  }

  /**
   * Unified Memory: Record outcome
   */
  async unifiedMemoryRecordOutcome(payload: {
    taskId: string;
    success: boolean;
    score: number;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryRecordOutcome(payload);
  }

  /**
   * Unified Memory: Get stats
   */
  async unifiedMemoryGetStats() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryGetStats();
  }

  /**
   * Unified Memory: Get sessions
   */
  async unifiedMemoryGetSessions(limit?: number) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryGetSessions(limit);
  }

  /**
   * Unified Memory: Get patterns
   */
  async unifiedMemoryGetPatterns(minSuccessRate?: number) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryGetPatterns(minSuccessRate);
  }

  /**
   * Unified Memory: Get workflows
   */
  async unifiedMemoryGetWorkflows() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryGetWorkflows();
  }

  /**
   * Unified Memory: Save state
   */
  async unifiedMemorySave() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemorySave();
  }

  /**
   * Unified Memory: Load state
   */
  async unifiedMemoryLoad(snapshot: Record<string, unknown>) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryLoad(snapshot);
  }

  /**
   * Unified Memory: Configure
   */
  async unifiedMemoryConfigure(config: Record<string, unknown>) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryConfigure(config);
  }

  // ============================================
  // Phase 9: Debate (9.3)
  // ============================================

  /**
   * Start a debate
   */
  async debateStart(payload: {
    query: string;
    context?: string;
    config?: Record<string, unknown>;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.debateStart(payload);
  }

  /**
   * Get debate result
   */
  async debateGetResult(debateId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.debateGetResult(debateId);
  }

  /**
   * Get active debates
   */
  async debateGetActive() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.debateGetActive();
  }

  /**
   * Cancel debate
   */
  async debateCancel(debateId: string) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.debateCancel(debateId);
  }

  /**
   * Get debate stats
   */
  async debateGetStats() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.debateGetStats();
  }

  // ============================================
  // Phase 9: Training/GRPO (9.4)
  // ============================================

  /**
   * Record training outcome
   */
  async trainingRecordOutcome(payload: {
    taskId: string;
    prompt: string;
    response: string;
    reward: number;
    strategy?: string;
    context?: string;
  }) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.trainingRecordOutcome(payload);
  }

  /**
   * Get training stats
   */
  async trainingGetStats() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.trainingGetStats();
  }

  /**
   * Export training data
   */
  async trainingExportData() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.trainingExportData();
  }

  /**
   * Import training data
   */
  async trainingImportData(data: Record<string, unknown>) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.trainingImportData(data);
  }

  /**
   * Get reward trend
   */
  async trainingGetTrend() {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.trainingGetTrend();
  }

  /**
   * Get top strategies
   */
  async trainingGetTopStrategies(limit?: number) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.trainingGetTopStrategies(limit);
  }

  /**
   * Configure training
   */
  async trainingConfigure(config: Record<string, unknown>) {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.trainingConfigure(config);
  }
}
