/**
 * Verification State Service - Shared state holder for verification sub-stores
 *
 * This service holds the single source of truth for verification state.
 * All sub-stores inject this service to read/update state.
 */

import { Injectable, signal } from '@angular/core';
import type {
  VerificationStoreState,
  VerificationSession,
  VerificationUIConfig,
  CliDetectionResult,
  VerificationStatus,
  AgentProgress,
  CliType,
} from './verification.types';
import { DEFAULT_VERIFICATION_CONFIG } from './verification.types';

@Injectable({ providedIn: 'root' })
export class VerificationStateService {
  // ============================================
  // Main State Signal
  // ============================================

  readonly state = signal<VerificationStoreState>({
    cliDetection: null,
    isScanning: false,
    scanError: null,
    currentSession: null,
    sessions: [],
    defaultConfig: DEFAULT_VERIFICATION_CONFIG,
    selectedAgents: DEFAULT_VERIFICATION_CONFIG.cliAgents.slice(
      0,
      Math.max(1, DEFAULT_VERIFICATION_CONFIG.agentCount),
    ),
    configPanelOpen: false,
    selectedTab: 'dashboard',
  });

  // ============================================
  // CLI Detection Helpers
  // ============================================

  setScanning(isScanning: boolean, error?: string | null): void {
    this.state.update((s) => ({
      ...s,
      isScanning,
      scanError: error ?? null,
    }));
  }

  setCliDetection(detection: CliDetectionResult): void {
    this.state.update((s) => ({
      ...s,
      cliDetection: detection,
      isScanning: false,
    }));
  }

  // ============================================
  // Session Helpers
  // ============================================

  setCurrentSession(session: VerificationSession | null): void {
    this.state.update((s) => ({ ...s, currentSession: session }));
  }

  addSession(session: VerificationSession): void {
    this.state.update((s) => ({
      ...s,
      currentSession: session,
      sessions: [session, ...s.sessions].slice(0, 50),
    }));
  }

  updateSession(sessionId: string, updates: Partial<VerificationSession>): void {
    this.state.update((s) => {
      if (s.currentSession?.id !== sessionId) return s;

      const updatedSession = { ...s.currentSession, ...updates };
      return {
        ...s,
        currentSession: updatedSession,
        sessions: s.sessions.map((session) =>
          session.id === sessionId ? updatedSession : session
        ),
      };
    });
  }

  updateSessionStatus(sessionId: string, status: VerificationStatus, error?: string): void {
    this.state.update((s) => {
      if (s.currentSession?.id !== sessionId) return s;

      const updatedSession: VerificationSession = {
        ...s.currentSession,
        status,
        error,
        completedAt: status !== 'running' ? Date.now() : undefined,
      };

      return {
        ...s,
        currentSession: updatedSession,
        sessions: s.sessions.map((session) =>
          session.id === sessionId ? updatedSession : session
        ),
      };
    });
  }

  updateAgentProgress(sessionId: string, agentId: string, progress: AgentProgress): void {
    this.state.update((s) => {
      if (s.currentSession?.id !== sessionId) return s;

      const newProgress = new Map(s.currentSession.agentProgress);
      newProgress.set(agentId, progress);

      return {
        ...s,
        currentSession: {
          ...s.currentSession,
          agentProgress: newProgress,
        },
      };
    });
  }

  deleteSession(sessionId: string): void {
    this.state.update((s) => ({
      ...s,
      sessions: s.sessions.filter((session) => session.id !== sessionId),
      currentSession: s.currentSession?.id === sessionId ? null : s.currentSession,
    }));
  }

  clearSessions(): void {
    this.state.update((s) => ({ ...s, sessions: [] }));
  }

  getSession(sessionId: string): VerificationSession | undefined {
    const state = this.state();
    if (state.currentSession?.id === sessionId) {
      return state.currentSession;
    }
    return state.sessions.find((s) => s.id === sessionId);
  }

  // ============================================
  // Configuration Helpers
  // ============================================

  updateConfig(config: Partial<VerificationUIConfig>): void {
    this.state.update((s) => ({
      ...s,
      defaultConfig: { ...s.defaultConfig, ...config },
    }));
  }

  setSelectedAgents(agents: CliType[]): void {
    this.state.update((s) => ({
      ...s,
      selectedAgents: agents,
      defaultConfig: { ...s.defaultConfig, cliAgents: agents },
    }));
  }

  // ============================================
  // UI State Helpers
  // ============================================

  setConfigPanelOpen(open: boolean): void {
    this.state.update((s) => ({ ...s, configPanelOpen: open }));
  }

  setSelectedTab(tab: 'dashboard' | 'monitor' | 'results'): void {
    this.state.update((s) => ({ ...s, selectedTab: tab }));
  }

  // ============================================
  // Bulk State Update (for loading stored state)
  // ============================================

  mergeState(updates: Partial<VerificationStoreState>): void {
    this.state.update((s) => ({ ...s, ...updates }));
  }
}
