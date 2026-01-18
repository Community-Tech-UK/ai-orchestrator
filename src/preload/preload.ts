/**
 * Preload Script - Exposes safe IPC API to renderer
 *
 * NOTE: This file must be self-contained. Electron's sandboxed preload
 * cannot resolve imports from other directories at runtime.
 */

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// IPC Channel names - must match main process exactly
// (Duplicated here because preload can't import from shared)
const IPC_CHANNELS = {
  // Instance management
  INSTANCE_CREATE: 'instance:create',
  INSTANCE_SEND_INPUT: 'instance:send-input',
  INSTANCE_TERMINATE: 'instance:terminate',
  INSTANCE_TERMINATE_ALL: 'instance:terminate-all',
  INSTANCE_RESTART: 'instance:restart',
  INSTANCE_RENAME: 'instance:rename',
  INSTANCE_LIST: 'instance:list',

  // Instance events (main -> renderer)
  INSTANCE_CREATED: 'instance:created',
  INSTANCE_REMOVED: 'instance:removed',
  INSTANCE_STATE_UPDATE: 'instance:state-update',
  INSTANCE_OUTPUT: 'instance:output',
  INSTANCE_BATCH_UPDATE: 'instance:batch-update',

  // App
  APP_READY: 'app:ready',
  APP_GET_VERSION: 'app:get-version',

  // CLI detection
  CLI_DETECT_ALL: 'cli:detect-all',
  CLI_CHECK: 'cli:check',

  // Dialogs
  DIALOG_SELECT_FOLDER: 'dialog:select-folder',

  // Settings
  SETTINGS_GET_ALL: 'settings:get-all',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_UPDATE: 'settings:update',
  SETTINGS_RESET: 'settings:reset',
  SETTINGS_RESET_ONE: 'settings:reset-one',
  SETTINGS_CHANGED: 'settings:changed',

  // Memory management
  MEMORY_GET_STATS: 'memory:get-stats',
  MEMORY_STATS_UPDATE: 'memory:stats-update',
  MEMORY_WARNING: 'memory:warning',
  MEMORY_CRITICAL: 'memory:critical',
  MEMORY_LOAD_HISTORY: 'memory:load-history',
} as const;

// Response type
interface IpcResponse {
  success: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    timestamp: number;
  };
}

/**
 * Electron API exposed to renderer
 */
const electronAPI = {
  // ============================================
  // Instance Management
  // ============================================

  /**
   * Create a new Claude instance
   */
  createInstance: (payload: {
    workingDirectory: string;
    sessionId?: string;
    parentInstanceId?: string;
    displayName?: string;
    initialPrompt?: string;
    attachments?: unknown[];
    yoloMode?: boolean;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.INSTANCE_CREATE, payload);
  },

  /**
   * Send input to an instance
   */
  sendInput: (payload: {
    instanceId: string;
    message: string;
    attachments?: unknown[];
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.INSTANCE_SEND_INPUT, payload);
  },

  /**
   * Terminate an instance
   */
  terminateInstance: (payload: {
    instanceId: string;
    graceful?: boolean;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.INSTANCE_TERMINATE, payload);
  },

  /**
   * Restart an instance
   */
  restartInstance: (payload: {
    instanceId: string;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.INSTANCE_RESTART, payload);
  },

  /**
   * Rename an instance
   */
  renameInstance: (payload: {
    instanceId: string;
    displayName: string;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.INSTANCE_RENAME, payload);
  },

  /**
   * Terminate all instances
   */
  terminateAllInstances: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.INSTANCE_TERMINATE_ALL);
  },

  /**
   * Get all instances
   */
  listInstances: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.INSTANCE_LIST);
  },

  // ============================================
  // Event Listeners
  // ============================================

  /**
   * Listen for instance created events
   */
  onInstanceCreated: (callback: (instance: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, instance: unknown) => callback(instance);
    ipcRenderer.on(IPC_CHANNELS.INSTANCE_CREATED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.INSTANCE_CREATED, handler);
  },

  /**
   * Listen for instance removed events
   */
  onInstanceRemoved: (callback: (instanceId: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, instanceId: string) => callback(instanceId);
    ipcRenderer.on(IPC_CHANNELS.INSTANCE_REMOVED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.INSTANCE_REMOVED, handler);
  },

  /**
   * Listen for instance state updates
   */
  onInstanceStateUpdate: (callback: (update: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, update: unknown) => callback(update);
    ipcRenderer.on(IPC_CHANNELS.INSTANCE_STATE_UPDATE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.INSTANCE_STATE_UPDATE, handler);
  },

  /**
   * Listen for instance output
   */
  onInstanceOutput: (callback: (output: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, output: unknown) => callback(output);
    ipcRenderer.on(IPC_CHANNELS.INSTANCE_OUTPUT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.INSTANCE_OUTPUT, handler);
  },

  /**
   * Listen for batch updates
   */
  onBatchUpdate: (callback: (batch: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, batch: unknown) => callback(batch);
    ipcRenderer.on(IPC_CHANNELS.INSTANCE_BATCH_UPDATE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.INSTANCE_BATCH_UPDATE, handler);
  },

  // ============================================
  // App
  // ============================================

  /**
   * Signal app ready
   */
  appReady: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.APP_READY);
  },

  /**
   * Get app version
   */
  getVersion: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION);
  },

  // ============================================
  // CLI Detection
  // ============================================

  /**
   * Detect all available CLIs
   */
  detectClis: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.CLI_DETECT_ALL);
  },

  /**
   * Check if a specific CLI is available
   */
  checkCli: (cliType: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.CLI_CHECK, cliType);
  },

  // ============================================
  // Dialogs
  // ============================================

  /**
   * Open folder selection dialog
   * Returns the selected folder path or null if cancelled
   */
  selectFolder: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FOLDER);
  },

  // ============================================
  // Settings
  // ============================================

  /**
   * Get all settings
   */
  getSettings: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_ALL);
  },

  /**
   * Get a single setting
   */
  getSetting: (key: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET, key);
  },

  /**
   * Set a single setting
   */
  setSetting: (key: string, value: unknown): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, { key, value });
  },

  /**
   * Update multiple settings
   */
  updateSettings: (settings: Record<string, unknown>): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_UPDATE, { settings });
  },

  /**
   * Reset all settings to defaults
   */
  resetSettings: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_RESET);
  },

  /**
   * Reset a single setting to default
   */
  resetSetting: (key: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_RESET_ONE, { key });
  },

  /**
   * Listen for settings changes
   */
  onSettingsChanged: (callback: (data: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.SETTINGS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SETTINGS_CHANGED, handler);
  },

  // ============================================
  // Memory Management
  // ============================================

  /**
   * Get current memory stats
   */
  getMemoryStats: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET_STATS);
  },

  /**
   * Load historical output from disk for an instance
   */
  loadHistoricalOutput: (instanceId: string, limit?: number): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_LOAD_HISTORY, { instanceId, limit });
  },

  /**
   * Listen for memory stats updates
   */
  onMemoryStatsUpdate: (callback: (stats: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, stats: unknown) => callback(stats);
    ipcRenderer.on(IPC_CHANNELS.MEMORY_STATS_UPDATE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MEMORY_STATS_UPDATE, handler);
  },

  /**
   * Listen for memory warnings
   */
  onMemoryWarning: (callback: (warning: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, warning: unknown) => callback(warning);
    ipcRenderer.on(IPC_CHANNELS.MEMORY_WARNING, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MEMORY_WARNING, handler);
  },

  /**
   * Listen for critical memory alerts
   */
  onMemoryCritical: (callback: (alert: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, alert: unknown) => callback(alert);
    ipcRenderer.on(IPC_CHANNELS.MEMORY_CRITICAL, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MEMORY_CRITICAL, handler);
  },

  // ============================================
  // Platform Info
  // ============================================

  /**
   * Get current platform
   */
  platform: process.platform,
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// Type declaration for TypeScript
export type ElectronAPI = typeof electronAPI;
