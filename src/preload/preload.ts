/**
 * Preload Script - Exposes safe IPC API to renderer
 *
 * This file composes domain-specific modules into the unified electronAPI.
 * Each domain module is a factory that receives (ipcRenderer, IPC_CHANNELS)
 * and returns the methods for that domain.
 *
 * NOTE: Electron's sandboxed preload cannot import from packages/ at runtime.
 * IPC_CHANNELS are generated into src/preload/generated/channels.ts by
 * `npm run generate:ipc` from the contracts package source of truth.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from './generated/channels';

import { createInstanceDomain } from './domains/instance.preload';
import { createFileDomain } from './domains/file.preload';
import { createSessionDomain } from './domains/session.preload';
import { createOrchestrationDomain } from './domains/orchestration.preload';
import { createWorkflowDomain } from './domains/workflow.preload';
import { createPromptHistoryDomain } from './domains/prompt-history.preload';
import { createPauseDomain } from './domains/pause.preload';
import { createDiagnosticsDomain } from './domains/diagnostics.preload';
import { createMemoryDomain } from './domains/memory.preload';
import { createProviderDomain } from './domains/provider.preload';
import { createInfrastructureDomain } from './domains/infrastructure.preload';
import { createCommunicationDomain } from './domains/communication.preload';
import { createLearningDomain } from './domains/learning.preload';
import { createWorkspaceDomain } from './domains/workspace.preload';
import { createAutomationDomain } from './domains/automation.preload';
import { createVoiceDomain } from './domains/voice.preload';
import { createBrowserDomain } from './domains/browser.preload';
import { createConversationLedgerDomain } from './domains/conversation-ledger.preload';
import type { IpcResponse } from './domains/types';

// --- Auth token shared across domains that need authenticated IPC calls ---
let ipcAuthToken: string | null = null;

const withAuth = (
  payload: Record<string, unknown> = {}
): Record<string, unknown> & { ipcAuthToken?: string } => ({
  ...payload,
  ipcAuthToken: ipcAuthToken || undefined
});

/**
 * Electron API exposed to renderer — composed from 10 domain modules.
 */
const electronAPI = {
  ...createInstanceDomain(ipcRenderer, IPC_CHANNELS),
  ...createFileDomain(ipcRenderer, IPC_CHANNELS),
  ...createSessionDomain(ipcRenderer, IPC_CHANNELS),
  ...createOrchestrationDomain(ipcRenderer, IPC_CHANNELS),
  ...createWorkflowDomain(ipcRenderer, IPC_CHANNELS),
  ...createPromptHistoryDomain(ipcRenderer, IPC_CHANNELS),
  ...createPauseDomain(ipcRenderer, IPC_CHANNELS),
  ...createDiagnosticsDomain(ipcRenderer, IPC_CHANNELS),
  ...createMemoryDomain(ipcRenderer, IPC_CHANNELS),
  ...createProviderDomain(ipcRenderer, IPC_CHANNELS, withAuth),
  ...createInfrastructureDomain(ipcRenderer, IPC_CHANNELS, withAuth),
  ...createCommunicationDomain(ipcRenderer, IPC_CHANNELS),
  ...createLearningDomain(ipcRenderer, IPC_CHANNELS),
  ...createWorkspaceDomain(ipcRenderer, IPC_CHANNELS),
  ...createAutomationDomain(ipcRenderer, IPC_CHANNELS),
  ...createVoiceDomain(ipcRenderer, IPC_CHANNELS, withAuth),
  ...createBrowserDomain(ipcRenderer, IPC_CHANNELS),
  ...createConversationLedgerDomain(ipcRenderer, IPC_CHANNELS),

  /**
   * Get current platform
   */
  platform: process.platform,
};

// Capture ipcAuthToken when appReady resolves (set by infrastructure domain)
const origAppReady = electronAPI.appReady;
if (origAppReady) {
  electronAPI.appReady = (): Promise<IpcResponse> =>
    origAppReady().then((response) => {
      const data = response?.data as { ipcAuthToken?: string } | undefined;
      if (data?.ipcAuthToken) {
        ipcAuthToken = data.ipcAuthToken;
      }
      return response;
    });
}

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// Type declaration for TypeScript
export type ElectronAPI = typeof electronAPI;
