/**
 * Verification Store - Angular Signals-based state management
 *
 * This is the main store coordinator that:
 * 1. Injects all sub-stores
 * 2. Sets up IPC listeners and routes events
 * 3. Exposes a unified public API
 * 4. Re-exports queries for consumers
 */

import { Injectable, inject, OnDestroy, computed, signal } from '@angular/core';
import { ElectronIpcService } from '../../services/ipc';

// Sub-stores
import { VerificationStateService } from './verification-state.service';
import { VerificationQueries } from './verification.queries';
import { VerificationCliStore } from './verification-cli.store';
import { VerificationConfigStore } from './verification-config.store';
import { VerificationSessionStore } from './verification-session.store';

// Types
import type {
  VerificationUIConfig,
  CliType,
  VerificationSession,
  VerificationResult,
  AgentResponse,
  VerificationVerdict,
  VerificationVerdictReadyPayload,
} from './verification.types';

@Injectable({ providedIn: 'root' })
export class VerificationStore implements OnDestroy {
  // Inject sub-stores
  private cliStore = inject(VerificationCliStore);
  private configStore = inject(VerificationConfigStore);
  private sessionStore = inject(VerificationSessionStore);

  // Inject shared state and queries
  private stateService = inject(VerificationStateService);
  private queries = inject(VerificationQueries);

  // Infrastructure
  private ipc = inject(ElectronIpcService);
  private unsubscribes: (() => void)[] = [];
  private _verdictsByResultId = signal(new Map<string, VerificationVerdict>());

  // ============================================
  // Re-export Queries for backwards compatibility
  // ============================================

  // CLI Detection
  readonly cliDetection = this.queries.cliDetection;
  readonly availableClis = this.queries.availableClis;
  readonly unavailableClis = this.queries.unavailableClis;
  readonly detectedClis = this.queries.detectedClis;
  readonly isScanning = this.queries.isScanning;
  readonly scanError = this.queries.scanError;

  // Session
  readonly currentSession = this.queries.currentSession;
  readonly isRunning = this.queries.isRunning;
  readonly sessionStatus = this.queries.sessionStatus;
  readonly agentProgressList = this.queries.agentProgressList;
  readonly consensusScore = this.queries.consensusScore;
  readonly roundInfo = this.queries.roundInfo;
  readonly result = this.queries.result;

  // History
  readonly sessions = this.queries.sessions;
  readonly recentSessions = this.queries.recentSessions;

  // Configuration
  readonly defaultConfig = this.queries.defaultConfig;
  readonly config = this.queries.config;
  readonly selectedAgents = this.queries.selectedAgents;

  // UI State
  readonly configPanelOpen = this.queries.configPanelOpen;
  readonly selectedTab = this.queries.selectedTab;
  readonly currentVerdict = computed(() => {
    const result = this.result();
    if (!result) {
      return null;
    }
    return this._verdictsByResultId().get(result.id) ?? null;
  });

  // ============================================
  // Constructor & Lifecycle
  // ============================================

  constructor() {
    this.setupEventListeners();
    this.configStore.loadStoredState();
  }

  ngOnDestroy(): void {
    this.unsubscribes.forEach((unsub) => unsub());
  }

  // ============================================
  // Setup Methods
  // ============================================

  private setupEventListeners(): void {
    console.log('[VerificationStore] Setting up event listeners');

    // Agent started
    const unsubAgentStart = this.ipc.getApi()?.onVerificationAgentStart(
      (rawData: unknown) => {
        console.log('[VerificationStore] Received agent-start event:', rawData);
        const data = rawData as {
          sessionId: string;
          agentId: string;
          name: string;
          type: string;
          personality?: string;
        };
        this.sessionStore.handleAgentStart(data);
      }
    ) ?? (() => { /* noop */ });
    this.unsubscribes.push(unsubAgentStart);

    // Agent streaming
    const unsubAgentStream = this.ipc.getApi()?.onVerificationAgentStream(
      (rawData: unknown) => {
        console.log('[VerificationStore] Received agent-stream event:', rawData);
        const data = rawData as {
          sessionId: string;
          agentId: string;
          chunk: string;
        };
        this.sessionStore.handleAgentStream(data);
      }
    ) ?? (() => { /* noop */ });
    this.unsubscribes.push(unsubAgentStream);

    // Agent complete
    const unsubAgentComplete = this.ipc.getApi()?.onVerificationAgentComplete(
      (rawData: unknown) => {
        console.log('[VerificationStore] Received agent-complete event:', rawData);
        const data = rawData as {
          sessionId: string;
          response: AgentResponse;
        };
        this.sessionStore.handleAgentComplete(data);
      }
    ) ?? (() => { /* noop */ });
    this.unsubscribes.push(unsubAgentComplete);

    // Round progress
    const unsubRoundProgress = this.ipc.getApi()?.onVerificationRoundProgress(
      (rawData: unknown) => {
        const data = rawData as {
          sessionId: string;
          round: number;
          total: number;
        };
        this.sessionStore.handleRoundProgress(data);
      }
    ) ?? (() => { /* noop */ });
    this.unsubscribes.push(unsubRoundProgress);

    // Consensus update
    const unsubConsensus = this.ipc.getApi()?.onVerificationConsensusUpdate(
      (rawData: unknown) => {
        const data = rawData as { sessionId: string; score: number };
        this.sessionStore.handleConsensusUpdate(data);
      }
    ) ?? (() => { /* noop */ });
    this.unsubscribes.push(unsubConsensus);

    // Verification complete
    const unsubComplete = this.ipc.getApi()?.onVerificationComplete(
      (rawData: unknown) => {
        console.log('[VerificationStore] Received verification-complete event:', rawData);
        const data = rawData as {
          sessionId: string;
          result: VerificationResult;
        };
        this.sessionStore.handleVerificationComplete(data);
      }
    ) ?? (() => { /* noop */ });
    this.unsubscribes.push(unsubComplete);

    // Canonical verdict derived from the completed verification result.
    const unsubVerdictReady = this.ipc.getApi()?.onVerificationVerdictReady(
      (rawData: unknown) => {
        const data = rawData as VerificationVerdictReadyPayload;
        this._verdictsByResultId.update((current) => {
          const next = new Map(current);
          next.set(data.resultId, data.verdict);
          return next;
        });
      }
    ) ?? (() => { /* noop */ });
    this.unsubscribes.push(unsubVerdictReady);

    // Verification error
    const unsubError = this.ipc.getApi()?.onVerificationError(
      (rawData: unknown) => {
        console.log('[VerificationStore] Received verification-error event:', rawData);
        const data = rawData as { sessionId: string; error: string };
        this.sessionStore.handleVerificationError(data);
      }
    ) ?? (() => { /* noop */ });
    this.unsubscribes.push(unsubError);

    console.log('[VerificationStore] Event listeners setup complete');
  }

  // ============================================
  // Public Actions - CLI Detection
  // ============================================

  /** Scan for available CLIs */
  async scanClis(force = false): Promise<void> {
    return this.cliStore.scanClis(force);
  }

  /** Test CLI connection */
  async testCliConnection(command: string): Promise<boolean> {
    return this.cliStore.testCliConnection(command);
  }

  // ============================================
  // Public Actions - Verification
  // ============================================

  /** Start a new verification session */
  async startVerification(
    prompt: string,
    context?: string,
    files?: File[],
    workingDirectory?: string
  ): Promise<string> {
    return this.sessionStore.startVerification(prompt, context, files, workingDirectory);
  }

  /** Cancel current verification */
  async cancelVerification(): Promise<void> {
    return this.sessionStore.cancelVerification();
  }

  /** Get session by ID */
  getSession(sessionId: string): VerificationSession | undefined {
    return this.sessionStore.getSession(sessionId);
  }

  /** View session results */
  viewSessionResults(sessionId: string): void {
    this.sessionStore.viewSessionResults(sessionId);
  }

  /** Delete a specific session */
  deleteSession(sessionId: string): void {
    this.sessionStore.deleteSession(sessionId);
  }

  /** Clear session history */
  clearHistory(): void {
    this.sessionStore.clearHistory();
  }

  // ============================================
  // Public Actions - Configuration
  // ============================================

  /** Update default configuration */
  setDefaultConfig(config: Partial<VerificationUIConfig>): void {
    this.configStore.setDefaultConfig(config);
  }

  /** Alias for setDefaultConfig (used by settings components) */
  updateConfig(config: Partial<VerificationUIConfig>): void {
    this.configStore.updateConfig(config);
  }

  /** Set selected agents */
  setSelectedAgents(agents: CliType[]): void {
    this.configStore.setSelectedAgents(agents);
  }

  /** Add agent to selection */
  addSelectedAgent(agent: CliType): void {
    this.configStore.addSelectedAgent(agent);
  }

  /** Remove agent from selection */
  removeSelectedAgent(agent: CliType): void {
    this.configStore.removeSelectedAgent(agent);
  }

  // ============================================
  // Public Actions - UI
  // ============================================

  /** Toggle config panel */
  toggleConfigPanel(): void {
    const state = this.stateService.state();
    this.stateService.setConfigPanelOpen(!state.configPanelOpen);
  }

  /** Close config panel */
  closeConfigPanel(): void {
    this.stateService.setConfigPanelOpen(false);
  }

  /** Set selected tab */
  setSelectedTab(tab: 'dashboard' | 'monitor' | 'results'): void {
    this.stateService.setSelectedTab(tab);
  }
}
