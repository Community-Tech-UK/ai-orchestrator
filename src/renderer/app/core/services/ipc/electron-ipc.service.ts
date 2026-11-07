/**
 * Base Electron IPC Service - Core IPC communication bridge
 *
 * This is the foundation service that provides low-level IPC communication
 * between the Angular renderer and Electron main process.
 *
 * Domain-specific services should inject this and use invoke/on methods.
 */

import { Injectable, NgZone, inject } from '@angular/core';
import type { ElectronAPI } from '../../../../../preload/preload';

/** Standard IPC response structure */
export interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { message: string; code?: string };
}

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

/** Copilot model info returned from CLI */
export interface CopilotModelInfo {
  id: string;
  name: string;
  supportsVision: boolean;
  contextWindow: number;
  enabled: boolean;
}

// Declare the electronAPI on window
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

/**
 * Convert a channel name like "archive:session" or "workflow:list-templates"
 * to a camelCase invoke method name like "archiveSession" / "workflowListTemplates".
 */
function channelToMethodName(channel: string): string {
  // Split on ':' and '-', capitalise each part after the first
  const parts = channel.split(/[:-]/);
  return parts
    .map((part, i) => i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Convert a channel name like "instance:output" to an "on" listener method
 * name like "onInstanceOutput".
 */
function channelToListenerName(channel: string): string {
  return 'on' + channelToMethodName(channel).charAt(0).toUpperCase() + channelToMethodName(channel).slice(1);
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
   * Get the underlying Electron API
   * Used by domain services to access specific API methods
   */
  getApi(): ElectronAPI | null {
    return this.api;
  }

  /**
   * Get NgZone for running callbacks in Angular zone
   */
  getNgZone(): NgZone {
    return this.ngZone;
  }

  /**
   * Invoke a typed IPC channel by name.
   *
   * Converts the channel string (e.g. "archive:session") to a camelCase method
   * name on the preload API (e.g. "archiveSession") and calls it.  This keeps
   * domain services working without exposing a generic escape-hatch in the
   * preload.
   *
   * If no matching typed method is found the call is silently rejected so that
   * callers receive the same { success: false } shape they already handle.
   */
  async invoke<T = unknown>(channel: string, payload?: unknown): Promise<IpcResponse<T>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };

    const methodName = channelToMethodName(channel);
    const apiRecord = this.api as Record<string, unknown>;
    const method = apiRecord[methodName];

    if (typeof method === 'function') {
      try {
        const result = await (method as (...args: unknown[]) => Promise<unknown>).call(this.api, payload);
        return result as IpcResponse<T>;
      } catch (error) {
        return { success: false, error: { message: (error as Error).message } };
      }
    }

    console.warn(`[ElectronIpcService] No typed wrapper found for channel: ${channel} (tried method: ${methodName})`);
    return { success: false, error: { message: `No typed handler for channel: ${channel}` } };
  }

  /**
   * Subscribe to a typed push event by channel name.
   *
   * Converts the channel string (e.g. "instance:output") to an "onXxx" method
   * name on the preload API (e.g. "onInstanceOutput") and registers the
   * callback through that typed listener.  Returns an unsubscribe function.
   */
  on(channel: string, callback: (data: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };

    const listenerName = channelToListenerName(channel);
    const apiRecord = this.api as Record<string, unknown>;
    const listener = apiRecord[listenerName];

    if (typeof listener === 'function') {
      const wrappedCallback = (data: unknown) => this.ngZone.run(() => callback(data));
      const unsub = (listener as (cb: (data: unknown) => void) => () => void).call(this.api, wrappedCallback);
      return typeof unsub === 'function' ? unsub : () => { /* noop */ };
    }

    console.warn(`[ElectronIpcService] No typed listener found for channel: ${channel} (tried: ${listenerName})`);
    return () => { /* noop */ };
  }

  /**
   * Helper to wrap API calls with standard error handling
   */
  protected async wrapApiCall<T>(
    apiMethod: () => Promise<IpcResponse<T>>
  ): Promise<IpcResponse<T>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return apiMethod();
  }

  /**
   * Helper to wrap event subscriptions with NgZone
   */
  protected wrapEventSubscription<T>(
    subscribe: (callback: (data: T) => void) => () => void,
    callback: (data: T) => void
  ): () => void {
    if (!this.api) return () => { /* noop */ };
    return subscribe((data: T) => {
      this.ngZone.run(() => callback(data));
    });
  }
}
