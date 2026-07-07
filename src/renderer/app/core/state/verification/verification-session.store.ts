/**
 * Verification Session Store - Manages verification session lifecycle
 */

import { Injectable, inject } from '@angular/core';
import { IpcFacadeService } from '../../services/ipc';
import { VerificationStateService } from './verification-state.service';
import { VerificationConfigStore } from './verification-config.store';
import type {
  VerificationSession,
  AgentProgress,
  PersonalityType,
  VerificationResult,
  AgentResponse,
} from './verification.types';

@Injectable({ providedIn: 'root' })
export class VerificationSessionStore {
  private stateService = inject(VerificationStateService);
  private configStore = inject(VerificationConfigStore);
  private ipc = inject(IpcFacadeService);

  /**
   * Start a new verification session
   */
  async startVerification(
    prompt: string,
    context?: string,
    files?: File[],
    workingDirectory?: string
  ): Promise<string> {
    const config = this.stateService.state().defaultConfig;
    const sessionId = `verify-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const session: VerificationSession = {
      id: sessionId,
      prompt,
      context,
      workingDirectory,
      config,
      status: 'running',
      startedAt: Date.now(),
      agentProgress: new Map(),
    };

    // Update state
    this.stateService.addSession(session);
    this.stateService.setSelectedTab('monitor');

    // Start verification via IPC
    try {
      await this.ipc.getApi()?.verificationStartCli({
        id: sessionId,
        prompt,
        context,
        config: {
          cliAgents: config.cliAgents,
          agentCount: config.agentCount,
          synthesisStrategy: config.synthesisStrategy,
          personalities: config.personalities,
          confidenceThreshold: config.confidenceThreshold,
          timeout: config.timeout,
          maxDebateRounds: config.maxDebateRounds,
          fallbackToApi: config.fallbackToApi,
          mixedMode: config.mixedMode,
        },
      });
    } catch (error) {
      this.stateService.updateSessionStatus(sessionId, 'error', (error as Error).message);
    }

    return sessionId;
  }

  /**
   * Cancel current verification
   */
  async cancelVerification(): Promise<void> {
    const session = this.stateService.state().currentSession;
    if (!session) return;

    try {
      await this.ipc.getApi()?.verificationCancel({ id: session.id });
      this.stateService.updateSessionStatus(session.id, 'cancelled');
    } catch (error) {
      console.error('Failed to cancel verification:', error);
    }
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): VerificationSession | undefined {
    return this.stateService.getSession(sessionId);
  }

  /**
   * View session results
   */
  viewSessionResults(sessionId: string): void {
    const session = this.stateService.getSession(sessionId);
    if (session?.result) {
      this.stateService.setCurrentSession(session);
      this.stateService.setSelectedTab('results');
    }
  }

  /**
   * Delete a specific session
   */
  deleteSession(sessionId: string): void {
    this.stateService.deleteSession(sessionId);
    this.configStore.saveStoredState();
  }

  /**
   * Clear session history
   */
  clearHistory(): void {
    this.stateService.clearSessions();
    this.configStore.saveStoredState();
  }

  // ============================================
  // Event Handlers (called from main store)
  // ============================================

  handleAgentStart(data: {
    sessionId: string;
    agentId: string;
    name: string;
    type: string;
    personality?: string;
  }): void {
    const state = this.stateService.state();
    if (state.currentSession?.id !== data.sessionId) return;

    const progress: AgentProgress = {
      agentId: data.agentId,
      name: data.name,
      type: data.type as 'cli' | 'api',
      personality: data.personality as PersonalityType,
      status: 'running',
      progress: 0,
      tokens: 0,
      cost: 0,
    };

    this.stateService.updateAgentProgress(data.sessionId, data.agentId, progress);
  }

  handleAgentStream(data: {
    sessionId: string;
    agentId: string;
    chunk: string;
  }): void {
    const state = this.stateService.state();
    if (state.currentSession?.id !== data.sessionId) return;

    const agent = state.currentSession.agentProgress.get(data.agentId);
    if (agent) {
      this.stateService.updateAgentProgress(data.sessionId, data.agentId, {
        ...agent,
        streamedContent: (agent.streamedContent || '') + data.chunk,
      });
    }
  }

  handleAgentComplete(data: {
    sessionId: string;
    response: AgentResponse;
  }): void {
    const state = this.stateService.state();
    if (state.currentSession?.id !== data.sessionId) return;

    const agent = state.currentSession.agentProgress.get(data.response.agentId);
    if (agent) {
      this.stateService.updateAgentProgress(data.sessionId, data.response.agentId, {
        ...agent,
        status: data.response.error ? 'error' : 'complete',
        progress: 100,
        tokens: data.response.tokens,
        cost: data.response.cost,
      });
    }
  }

  handleRoundProgress(data: {
    sessionId: string;
    round: number;
    total: number;
  }): void {
    this.stateService.updateSession(data.sessionId, {
      currentRound: data.round,
      totalRounds: data.total,
    });
  }

  handleConsensusUpdate(data: { sessionId: string; score: number }): void {
    this.stateService.updateSession(data.sessionId, {
      consensusScore: data.score,
    });
  }

  handleVerificationComplete(data: {
    sessionId: string;
    result: VerificationResult;
  }): void {
    this.stateService.updateSession(data.sessionId, {
      status: 'complete',
      completedAt: Date.now(),
      result: data.result,
    });
    this.stateService.setSelectedTab('results');
    this.configStore.saveStoredState();
  }

  handleVerificationError(data: { sessionId: string; error: string }): void {
    this.stateService.updateSessionStatus(data.sessionId, 'error', data.error);
  }
}
