/**
 * Verification Store - Angular Signals-based state management
 * Manages multi-agent verification state including CLI detection,
 * verification sessions, and real-time progress tracking.
 */

import { Injectable, inject, signal, computed, OnDestroy } from '@angular/core';
import { ElectronIpcService } from '../services/electron-ipc.service';
import type {
  CliInfo,
  CliType,
} from '../../../../shared/types/unified-cli-response';
import type {
  VerificationResult,
  VerificationConfig,
  AgentResponse,
  PersonalityType,
  SynthesisStrategy,
} from '../../../../shared/types/verification.types';

// ============================================
// Types
// ============================================

export type VerificationStatus = 'idle' | 'configuring' | 'running' | 'complete' | 'error' | 'cancelled';

export interface AgentProgress {
  agentId: string;
  name: string;
  type: 'cli' | 'api';
  personality?: PersonalityType;
  status: 'pending' | 'running' | 'complete' | 'error';
  progress: number;
  tokens: number;
  cost: number;
  currentActivity?: string;
  streamedContent?: string;
}

export interface VerificationSession {
  id: string;
  prompt: string;
  context?: string;
  config: VerificationUIConfig;
  status: VerificationStatus;
  startedAt: number;
  completedAt?: number;
  currentRound?: number;
  totalRounds?: number;
  consensusScore?: number;
  agentProgress: Map<string, AgentProgress>;
  result?: VerificationResult;
  error?: string;
}

export interface VerificationUIConfig {
  agentCount: number;
  cliAgents: CliType[];
  synthesisStrategy: SynthesisStrategy;
  personalities: PersonalityType[];
  confidenceThreshold: number;
  minAgreement: number;
  timeout: number;
  maxDebateRounds: number;
  fallbackToApi: boolean;
  mixedMode: boolean;
}

export interface CliDetectionResult {
  timestamp: number;
  detected: CliInfo[];
  available: CliInfo[];
  unavailable: CliInfo[];
}

interface StoreState {
  // CLI Detection
  cliDetection: CliDetectionResult | null;
  isScanning: boolean;
  scanError: string | null;

  // Current Session
  currentSession: VerificationSession | null;

  // Session History
  sessions: VerificationSession[];

  // Default Configuration
  defaultConfig: VerificationUIConfig;

  // UI State
  selectedAgents: CliType[];
  configPanelOpen: boolean;
  selectedTab: 'dashboard' | 'monitor' | 'results';
}

// ============================================
// Default Configuration
// ============================================

const DEFAULT_CONFIG: VerificationUIConfig = {
  agentCount: 3,
  cliAgents: ['claude', 'gemini', 'ollama'],
  synthesisStrategy: 'debate',
  personalities: ['methodical-analyst', 'creative-solver', 'devils-advocate'],
  confidenceThreshold: 0.7,
  minAgreement: 0.6,
  timeout: 300000,
  maxDebateRounds: 4,
  fallbackToApi: true,
  mixedMode: false,
};

// ============================================
// Store
// ============================================

@Injectable({ providedIn: 'root' })
export class VerificationStore implements OnDestroy {
  private ipc = inject(ElectronIpcService);
  private unsubscribes: (() => void)[] = [];

  // Private mutable state
  private state = signal<StoreState>({
    cliDetection: null,
    isScanning: false,
    scanError: null,
    currentSession: null,
    sessions: [],
    defaultConfig: DEFAULT_CONFIG,
    selectedAgents: ['claude', 'gemini', 'ollama'],
    configPanelOpen: false,
    selectedTab: 'dashboard',
  });

  // ============================================
  // Public Computed Selectors - CLI Detection
  // ============================================

  /** CLI detection result */
  readonly cliDetection = computed(() => this.state().cliDetection);

  /** Available CLIs */
  readonly availableClis = computed(() =>
    this.state().cliDetection?.available ?? []
  );

  /** Unavailable CLIs */
  readonly unavailableClis = computed(() =>
    this.state().cliDetection?.unavailable ?? []
  );

  /** Is scanning for CLIs */
  readonly isScanning = computed(() => this.state().isScanning);

  /** Scan error */
  readonly scanError = computed(() => this.state().scanError);

  // ============================================
  // Public Computed Selectors - Verification
  // ============================================

  /** Current verification session */
  readonly currentSession = computed(() => this.state().currentSession);

  /** Is verification running */
  readonly isRunning = computed(() =>
    this.state().currentSession?.status === 'running'
  );

  /** Current session status */
  readonly sessionStatus = computed(() =>
    this.state().currentSession?.status ?? 'idle'
  );

  /** Agent progress as array */
  readonly agentProgressList = computed(() => {
    const session = this.state().currentSession;
    if (!session) return [];
    return Array.from(session.agentProgress.values());
  });

  /** Current consensus score */
  readonly consensusScore = computed(() =>
    this.state().currentSession?.consensusScore ?? 0
  );

  /** Current round info */
  readonly roundInfo = computed(() => ({
    current: this.state().currentSession?.currentRound ?? 0,
    total: this.state().currentSession?.totalRounds ?? 4,
  }));

  /** Verification result */
  readonly result = computed(() =>
    this.state().currentSession?.result
  );

  /** Session history */
  readonly sessions = computed(() => this.state().sessions);

  /** Recent sessions (last 10) */
  readonly recentSessions = computed(() =>
    this.state().sessions.slice(0, 10)
  );

  // ============================================
  // Public Computed Selectors - UI
  // ============================================

  /** Default configuration */
  readonly defaultConfig = computed(() => this.state().defaultConfig);

  /** Alias for defaultConfig (used by preferences component) */
  readonly config = computed(() => this.state().defaultConfig);

  /** All detected CLIs */
  readonly detectedClis = computed(() =>
    this.state().cliDetection?.detected ?? []
  );

  /** Selected agents */
  readonly selectedAgents = computed(() => this.state().selectedAgents);

  /** Config panel open */
  readonly configPanelOpen = computed(() => this.state().configPanelOpen);

  /** Selected tab */
  readonly selectedTab = computed(() => this.state().selectedTab);

  // ============================================
  // Constructor
  // ============================================

  constructor() {
    this.setupEventListeners();
    this.loadStoredState();
  }

  ngOnDestroy(): void {
    this.unsubscribes.forEach((unsub) => unsub());
  }

  // ============================================
  // CLI Detection Actions
  // ============================================

  /** Scan for available CLIs */
  async scanClis(force = false): Promise<void> {
    this.state.update((s) => ({ ...s, isScanning: true, scanError: null }));

    try {
      const result = await this.ipc.invoke<CliDetectionResult>(
        'cli:detect-all',
        { force }
      );

      if (result.success && result.data) {
        this.state.update((s) => ({
          ...s,
          cliDetection: result.data!,
          isScanning: false,
        }));
      } else {
        throw new Error(result.error?.message || 'Failed to detect CLIs');
      }
    } catch (error) {
      this.state.update((s) => ({
        ...s,
        isScanning: false,
        scanError: (error as Error).message,
      }));
    }
  }

  /** Test CLI connection */
  async testCliConnection(command: string): Promise<boolean> {
    try {
      const result = await this.ipc.invoke<{ success: boolean }>(
        'cli:test-connection',
        { command }
      );
      return result.success && result.data?.success === true;
    } catch {
      return false;
    }
  }

  // ============================================
  // Verification Actions
  // ============================================

  /** Start a new verification session */
  async startVerification(prompt: string, context?: string): Promise<string> {
    const config = this.state().defaultConfig;
    const sessionId = `verify-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const session: VerificationSession = {
      id: sessionId,
      prompt,
      context,
      config,
      status: 'running',
      startedAt: Date.now(),
      agentProgress: new Map(),
    };

    // Update state
    this.state.update((s) => ({
      ...s,
      currentSession: session,
      sessions: [session, ...s.sessions].slice(0, 50),
      selectedTab: 'monitor',
    }));

    // Start verification via IPC
    try {
      await this.ipc.invoke('verification:start-cli', {
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
      this.updateSessionStatus(sessionId, 'error', (error as Error).message);
    }

    return sessionId;
  }

  /** Cancel current verification */
  async cancelVerification(): Promise<void> {
    const session = this.state().currentSession;
    if (!session) return;

    try {
      await this.ipc.invoke('verification:cancel', { id: session.id });
      this.updateSessionStatus(session.id, 'cancelled');
    } catch (error) {
      console.error('Failed to cancel verification:', error);
    }
  }

  /** Get session by ID */
  getSession(sessionId: string): VerificationSession | undefined {
    if (this.state().currentSession?.id === sessionId) {
      return this.state().currentSession ?? undefined;
    }
    return this.state().sessions.find((s) => s.id === sessionId);
  }

  // ============================================
  // Configuration Actions
  // ============================================

  /** Update default configuration */
  setDefaultConfig(config: Partial<VerificationUIConfig>): void {
    this.state.update((s) => ({
      ...s,
      defaultConfig: { ...s.defaultConfig, ...config },
    }));
    this.saveStoredState();
  }

  /** Alias for setDefaultConfig (used by settings components) */
  updateConfig(config: Partial<VerificationUIConfig>): void {
    this.setDefaultConfig(config);
  }

  /** Set selected agents */
  setSelectedAgents(agents: CliType[]): void {
    this.state.update((s) => ({
      ...s,
      selectedAgents: agents,
      defaultConfig: { ...s.defaultConfig, cliAgents: agents },
    }));
  }

  /** Add agent to selection */
  addSelectedAgent(agent: CliType): void {
    this.state.update((s) => {
      if (s.selectedAgents.includes(agent)) return s;
      const newAgents = [...s.selectedAgents, agent];
      return {
        ...s,
        selectedAgents: newAgents,
        defaultConfig: { ...s.defaultConfig, cliAgents: newAgents },
      };
    });
  }

  /** Remove agent from selection */
  removeSelectedAgent(agent: CliType): void {
    this.state.update((s) => {
      const newAgents = s.selectedAgents.filter((a) => a !== agent);
      return {
        ...s,
        selectedAgents: newAgents,
        defaultConfig: { ...s.defaultConfig, cliAgents: newAgents },
      };
    });
  }

  // ============================================
  // UI Actions
  // ============================================

  /** Toggle config panel */
  toggleConfigPanel(): void {
    this.state.update((s) => ({
      ...s,
      configPanelOpen: !s.configPanelOpen,
    }));
  }

  /** Close config panel */
  closeConfigPanel(): void {
    this.state.update((s) => ({ ...s, configPanelOpen: false }));
  }

  /** Set selected tab */
  setSelectedTab(tab: 'dashboard' | 'monitor' | 'results'): void {
    this.state.update((s) => ({ ...s, selectedTab: tab }));
  }

  /** View session results */
  viewSessionResults(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (session?.result) {
      this.state.update((s) => ({
        ...s,
        currentSession: session,
        selectedTab: 'results',
      }));
    }
  }

  /** Clear session history */
  clearHistory(): void {
    this.state.update((s) => ({ ...s, sessions: [] }));
    this.saveStoredState();
  }

  // ============================================
  // Private Helpers
  // ============================================

  private setupEventListeners(): void {
    console.log('[VerificationStore] Setting up event listeners');

    // Agent started
    const unsubAgentStart = this.ipc.on(
      'verification:agent-start',
      (rawData: unknown) => {
        console.log('[VerificationStore] Received agent-start event:', rawData);
        const data = rawData as { sessionId: string; agentId: string; name: string; type: string; personality?: string };
        this.handleAgentStart(data);
      }
    );
    this.unsubscribes.push(unsubAgentStart);

    // Agent streaming
    const unsubAgentStream = this.ipc.on(
      'verification:agent-stream',
      (rawData: unknown) => {
        console.log('[VerificationStore] Received agent-stream event:', rawData);
        const data = rawData as { sessionId: string; agentId: string; chunk: string };
        this.handleAgentStream(data);
      }
    );
    this.unsubscribes.push(unsubAgentStream);

    // Agent complete
    const unsubAgentComplete = this.ipc.on(
      'verification:agent-complete',
      (rawData: unknown) => {
        console.log('[VerificationStore] Received agent-complete event:', rawData);
        const data = rawData as { sessionId: string; response: AgentResponse };
        this.handleAgentComplete(data);
      }
    );
    this.unsubscribes.push(unsubAgentComplete);

    // Round progress
    const unsubRoundProgress = this.ipc.on(
      'verification:round-progress',
      (rawData: unknown) => {
        const data = rawData as { sessionId: string; round: number; total: number };
        this.handleRoundProgress(data);
      }
    );
    this.unsubscribes.push(unsubRoundProgress);

    // Consensus update
    const unsubConsensus = this.ipc.on(
      'verification:consensus-update',
      (rawData: unknown) => {
        const data = rawData as { sessionId: string; score: number };
        this.handleConsensusUpdate(data);
      }
    );
    this.unsubscribes.push(unsubConsensus);

    // Verification complete
    const unsubComplete = this.ipc.on(
      'verification:complete',
      (rawData: unknown) => {
        console.log('[VerificationStore] Received verification-complete event:', rawData);
        const data = rawData as { sessionId: string; result: VerificationResult };
        this.handleVerificationComplete(data);
      }
    );
    this.unsubscribes.push(unsubComplete);

    // Verification error
    const unsubError = this.ipc.on(
      'verification:error',
      (rawData: unknown) => {
        console.log('[VerificationStore] Received verification-error event:', rawData);
        const data = rawData as { sessionId: string; error: string };
        this.handleVerificationError(data);
      }
    );
    this.unsubscribes.push(unsubError);

    console.log('[VerificationStore] Event listeners setup complete');
  }

  private handleAgentStart(data: { sessionId: string; agentId: string; name: string; type: string; personality?: string }): void {
    this.state.update((s) => {
      if (s.currentSession?.id !== data.sessionId) return s;

      const newProgress = new Map(s.currentSession.agentProgress);
      newProgress.set(data.agentId, {
        agentId: data.agentId,
        name: data.name,
        type: data.type as 'cli' | 'api',
        personality: data.personality as PersonalityType,
        status: 'running',
        progress: 0,
        tokens: 0,
        cost: 0,
      });

      return {
        ...s,
        currentSession: {
          ...s.currentSession,
          agentProgress: newProgress,
        },
      };
    });
  }

  private handleAgentStream(data: { sessionId: string; agentId: string; chunk: string }): void {
    this.state.update((s) => {
      if (s.currentSession?.id !== data.sessionId) return s;

      const newProgress = new Map(s.currentSession.agentProgress);
      const agent = newProgress.get(data.agentId);
      if (agent) {
        newProgress.set(data.agentId, {
          ...agent,
          streamedContent: (agent.streamedContent || '') + data.chunk,
        });
      }

      return {
        ...s,
        currentSession: {
          ...s.currentSession,
          agentProgress: newProgress,
        },
      };
    });
  }

  private handleAgentComplete(data: { sessionId: string; response: AgentResponse }): void {
    this.state.update((s) => {
      if (s.currentSession?.id !== data.sessionId) return s;

      const newProgress = new Map(s.currentSession.agentProgress);
      const agent = newProgress.get(data.response.agentId);
      if (agent) {
        newProgress.set(data.response.agentId, {
          ...agent,
          status: data.response.error ? 'error' : 'complete',
          progress: 100,
          tokens: data.response.tokens,
          cost: data.response.cost,
        });
      }

      return {
        ...s,
        currentSession: {
          ...s.currentSession,
          agentProgress: newProgress,
        },
      };
    });
  }

  private handleRoundProgress(data: { sessionId: string; round: number; total: number }): void {
    this.state.update((s) => {
      if (s.currentSession?.id !== data.sessionId) return s;

      return {
        ...s,
        currentSession: {
          ...s.currentSession,
          currentRound: data.round,
          totalRounds: data.total,
        },
      };
    });
  }

  private handleConsensusUpdate(data: { sessionId: string; score: number }): void {
    this.state.update((s) => {
      if (s.currentSession?.id !== data.sessionId) return s;

      return {
        ...s,
        currentSession: {
          ...s.currentSession,
          consensusScore: data.score,
        },
      };
    });
  }

  private handleVerificationComplete(data: { sessionId: string; result: VerificationResult }): void {
    this.state.update((s) => {
      if (s.currentSession?.id !== data.sessionId) return s;

      const updatedSession: VerificationSession = {
        ...s.currentSession,
        status: 'complete',
        completedAt: Date.now(),
        result: data.result,
      };

      return {
        ...s,
        currentSession: updatedSession,
        sessions: s.sessions.map((session) =>
          session.id === data.sessionId ? updatedSession : session
        ),
        selectedTab: 'results',
      };
    });

    this.saveStoredState();
  }

  private handleVerificationError(data: { sessionId: string; error: string }): void {
    this.updateSessionStatus(data.sessionId, 'error', data.error);
  }

  private updateSessionStatus(
    sessionId: string,
    status: VerificationStatus,
    error?: string
  ): void {
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

  private loadStoredState(): void {
    try {
      const stored = localStorage.getItem('verification-store');
      if (stored) {
        const parsed = JSON.parse(stored);
        this.state.update((s) => ({
          ...s,
          defaultConfig: { ...s.defaultConfig, ...parsed.defaultConfig },
          selectedAgents: parsed.selectedAgents || s.selectedAgents,
          sessions: (parsed.sessions || []).map((session: VerificationSession) => ({
            ...session,
            agentProgress: new Map(),
          })),
        }));
      }
    } catch (error) {
      console.warn('Failed to load verification store state:', error);
    }
  }

  private saveStoredState(): void {
    try {
      const state = this.state();
      const toStore = {
        defaultConfig: state.defaultConfig,
        selectedAgents: state.selectedAgents,
        sessions: state.sessions.map((s) => ({
          ...s,
          agentProgress: [], // Don't persist progress maps
        })),
      };
      localStorage.setItem('verification-store', JSON.stringify(toStore));
    } catch (error) {
      console.warn('Failed to save verification store state:', error);
    }
  }
}
