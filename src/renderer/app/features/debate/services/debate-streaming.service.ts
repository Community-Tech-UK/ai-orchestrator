/**
 * Debate Streaming Service
 *
 * Real-time streaming support for debate visualization:
 * - Stream debate contributions as they arrive
 * - Update network graph in real-time
 * - Track consensus evolution
 * - Handle debate events
 */

import { Injectable, inject, signal, computed, OnDestroy } from '@angular/core';
import { Subject, BehaviorSubject, Observable } from 'rxjs';
import { takeUntil, filter, map } from 'rxjs/operators';
import { ElectronIpcService } from '../../../core/services/ipc';
import type { DebateResult } from '../../../../../shared/types/debate.types';

export type DebateStreamingStatus = 'idle' | 'connecting' | 'streaming' | 'paused' | 'completed' | 'error';

export interface StreamingDebateState {
  sessionId: string | null;
  status: DebateStreamingStatus;
  currentRound: number;
  totalRounds: number;
  contributions: StreamingContribution[];
  consensusScore: number;
  consensusHistory: ConsensusPoint[];
  networkNodes: NetworkNode[];
  networkLinks: NetworkLink[];
  error?: string;
  startedAt?: number;
  lastUpdate?: number;
}

export interface StreamingContribution {
  id: string;
  agentId: string;
  roundNumber: number;
  content: string;
  confidence: number;
  isStreaming: boolean;
  streamedContent: string;
  timestamp: number;
}

export interface ConsensusPoint {
  round: number;
  score: number;
  timestamp: number;
}

export interface NetworkNode {
  id: string;
  agentId: string;
  label: string;
  confidence: number;
  position?: string;
}

export interface NetworkLink {
  source: string;
  target: string;
  type: 'agreement' | 'critique' | 'refinement';
  weight: number;
}

export interface DebateStreamEvent {
  type: 'round-start' | 'contribution-start' | 'contribution-chunk' | 'contribution-end' | 'round-end' | 'consensus-update' | 'debate-complete' | 'error';
  sessionId: string;
  data: unknown;
  timestamp: number;
}

interface DebateStartConfig {
  agentCount?: number;
  maxRounds?: number;
  convergenceThreshold?: number;
}

interface DebateStartResponse {
  success: boolean;
  data?: unknown;
  error?: string | { message?: string };
}

const INITIAL_STATE: StreamingDebateState = {
  sessionId: null,
  status: 'idle',
  currentRound: 0,
  totalRounds: 0,
  contributions: [],
  consensusScore: 0,
  consensusHistory: [],
  networkNodes: [],
  networkLinks: [],
};

const DEFAULT_DEBATE_TOTAL_ROUNDS = 2;

@Injectable({
  providedIn: 'root',
})
export class DebateStreamingService implements OnDestroy {
  private ipc = inject(ElectronIpcService);
  private destroy$ = new Subject<void>();

  // State management
  private state$ = new BehaviorSubject<StreamingDebateState>({ ...INITIAL_STATE });

  // Event streams
  private events$ = new Subject<DebateStreamEvent>();

  // Signals for reactive UI
  readonly state = signal<StreamingDebateState>({ ...INITIAL_STATE });
  readonly status = computed(() => this.state().status);
  readonly currentRound = computed(() => this.state().currentRound);
  readonly consensusScore = computed(() => this.state().consensusScore);
  readonly isStreaming = computed(() => this.state().status === 'streaming');

  constructor() {
    // Subscribe to state changes
    this.state$.pipe(takeUntil(this.destroy$)).subscribe(state => {
      this.state.set(state);
    });

    // Set up IPC event listeners
    this.setupIpcListeners();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /**
   * Get the event stream as Observable
   */
  getEventStream(): Observable<DebateStreamEvent> {
    return this.events$.asObservable();
  }

  /**
   * Get events filtered by type
   */
  getEventsOfType<T>(type: DebateStreamEvent['type']): Observable<T> {
    return this.events$.pipe(
      filter(event => event.type === type),
      map(event => event.data as T)
    );
  }

  /**
   * Start streaming a new debate
   */
  async startDebate(query: string, config?: DebateStartConfig): Promise<string> {
    this.updateState({
      ...INITIAL_STATE,
      status: 'connecting',
      startedAt: Date.now(),
    });

    try {
      const result = await this.ipc.getApi()?.debateStart({
        query,
        config: this.toBackendConfig(config),
      });

      const sessionId = this.extractStartSessionId(result);
      if (sessionId) {
        this.updateState({
          sessionId,
          status: 'streaming',
          totalRounds: config?.maxRounds || DEFAULT_DEBATE_TOTAL_ROUNDS,
        });
        return sessionId;
      }

      throw new Error(this.extractStartError(result));
    } catch (error) {
      this.updateState({
        status: 'error',
        error: (error as Error).message,
      });
      throw error;
    }
  }

  private toBackendConfig(config?: DebateStartConfig): Record<string, number> | undefined {
    if (!config) return undefined;
    return {
      ...(typeof config.agentCount === 'number' ? { agents: config.agentCount } : {}),
      ...(typeof config.maxRounds === 'number' ? { maxRounds: config.maxRounds } : {}),
      ...(typeof config.convergenceThreshold === 'number'
        ? { convergenceThreshold: config.convergenceThreshold }
        : {}),
    };
  }

  private extractStartSessionId(result: unknown): string | null {
    if (typeof result === 'string' && result.length > 0) return result;
    if (!this.isStartResponse(result) || !result.success) return null;
    if (typeof result.data === 'string' && result.data.length > 0) return result.data;
    if (result.data && typeof result.data === 'object') {
      const data = result.data as Record<string, unknown>;
      if (typeof data['sessionId'] === 'string') return data['sessionId'];
      if (typeof data['debateId'] === 'string') return data['debateId'];
    }
    return null;
  }

  private extractStartError(result: unknown): string {
    if (!this.isStartResponse(result)) return 'Failed to start debate';
    if (typeof result.error === 'string') return result.error;
    return result.error?.message || 'Failed to start debate';
  }

  private isStartResponse(value: unknown): value is DebateStartResponse {
    return value !== null
      && typeof value === 'object'
      && typeof (value as { success?: unknown }).success === 'boolean';
  }

  /**
   * Pause the current debate
   */
  async pauseDebate(): Promise<void> {
    const sessionId = this.state().sessionId;
    if (!sessionId) return;

    await this.ipc.getApi()?.debatePause({ sessionId });
    this.updateState({ status: 'paused' });
  }

  /**
   * Resume a paused debate
   */
  async resumeDebate(): Promise<void> {
    const sessionId = this.state().sessionId;
    if (!sessionId) return;

    await this.ipc.getApi()?.debateResume({ sessionId });
    this.updateState({ status: 'streaming' });
  }

  /**
   * Stop the current debate
   */
  async stopDebate(): Promise<void> {
    const sessionId = this.state().sessionId;
    if (!sessionId) return;

    await this.ipc.getApi()?.debateStop({ sessionId });
    this.updateState({ status: 'idle' });
  }

  /**
   * Request human intervention
   */
  async requestIntervention(message: string): Promise<void> {
    const sessionId = this.state().sessionId;
    if (!sessionId) return;

    await this.ipc.getApi()?.debateIntervene({
      sessionId,
      message,
    });
  }

  /**
   * Set up IPC event listeners
   */
  private setupIpcListeners(): void {
    // Listen for debate events from main process
    this.ipc.getApi()?.onDebateEvent((data: unknown) => {
      const event = data as DebateStreamEvent;
      this.handleDebateEvent(event);
    });
  }

  /**
   * Handle incoming debate events
   */
  private handleDebateEvent(event: DebateStreamEvent): void {
    this.events$.next(event);

    switch (event.type) {
      case 'round-start':
        this.handleRoundStart(event.data as { roundNumber: number; roundType: string });
        break;

      case 'contribution-start':
        this.handleContributionStart(event.data as {
          contributionId: string;
          agentId: string;
          roundNumber: number;
        });
        break;

      case 'contribution-chunk':
        this.handleContributionChunk(event.data as {
          contributionId: string;
          chunk: string;
        });
        break;

      case 'contribution-end':
        this.handleContributionEnd(event.data as {
          contributionId: string;
          content: string;
          confidence: number;
        });
        break;

      case 'round-end':
        this.handleRoundEnd(event.data as {
          roundNumber: number;
          consensusScore: number;
        });
        break;

      case 'consensus-update':
        this.handleConsensusUpdate(event.data as {
          score: number;
          agreements: string[];
          disagreements: string[];
        });
        break;

      case 'debate-complete':
        this.handleDebateComplete(event.data as DebateResult);
        break;

      case 'error':
        this.handleError(event.data as { message: string });
        break;
    }
  }

  private handleRoundStart(data: { roundNumber: number; roundType: string }): void {
    this.updateState({
      currentRound: data.roundNumber,
    });
  }

  private handleContributionStart(data: {
    contributionId: string;
    agentId: string;
    roundNumber: number;
  }): void {
    const contributions = [...this.state().contributions];
    contributions.push({
      id: data.contributionId,
      agentId: data.agentId,
      roundNumber: data.roundNumber,
      content: '',
      confidence: 0,
      isStreaming: true,
      streamedContent: '',
      timestamp: Date.now(),
    });

    // Add/update network node
    const nodes = [...this.state().networkNodes];
    const existingNode = nodes.find(n => n.agentId === data.agentId);
    if (!existingNode) {
      nodes.push({
        id: data.contributionId,
        agentId: data.agentId,
        label: data.agentId,
        confidence: 0,
      });
    }

    this.updateState({
      contributions,
      networkNodes: nodes,
      lastUpdate: Date.now(),
    });
  }

  private handleContributionChunk(data: { contributionId: string; chunk: string }): void {
    const contributions = this.state().contributions.map(c => {
      if (c.id === data.contributionId) {
        return {
          ...c,
          streamedContent: c.streamedContent + data.chunk,
        };
      }
      return c;
    });

    this.updateState({
      contributions,
      lastUpdate: Date.now(),
    });
  }

  private handleContributionEnd(data: {
    contributionId: string;
    content: string;
    confidence: number;
  }): void {
    const contributions = this.state().contributions.map(c => {
      if (c.id === data.contributionId) {
        return {
          ...c,
          content: data.content,
          confidence: data.confidence,
          isStreaming: false,
        };
      }
      return c;
    });

    // Update network node confidence
    const nodes = this.state().networkNodes.map(n => {
      if (n.id === data.contributionId) {
        return { ...n, confidence: data.confidence };
      }
      return n;
    });

    this.updateState({
      contributions,
      networkNodes: nodes,
      lastUpdate: Date.now(),
    });
  }

  private handleRoundEnd(data: { roundNumber: number; consensusScore: number }): void {
    const consensusHistory = [...this.state().consensusHistory];
    consensusHistory.push({
      round: data.roundNumber,
      score: data.consensusScore,
      timestamp: Date.now(),
    });

    // Generate network links based on contributions in this round
    const roundContributions = this.state().contributions.filter(
      c => c.roundNumber === data.roundNumber
    );
    const links = [...this.state().networkLinks];

    // Create links between contributions in the same round
    for (let i = 0; i < roundContributions.length; i++) {
      for (let j = i + 1; j < roundContributions.length; j++) {
        const c1 = roundContributions[i];
        const c2 = roundContributions[j];

        // Determine link type based on content similarity
        const similarity = this.calculateSimilarity(c1.content, c2.content);
        const linkType: 'agreement' | 'critique' | 'refinement' =
          similarity > 0.7 ? 'agreement' :
          similarity > 0.3 ? 'refinement' : 'critique';

        links.push({
          source: c1.id,
          target: c2.id,
          type: linkType,
          weight: similarity,
        });
      }
    }

    this.updateState({
      consensusScore: data.consensusScore,
      consensusHistory,
      networkLinks: links,
      lastUpdate: Date.now(),
    });
  }

  private handleConsensusUpdate(data: {
    score: number;
    agreements: string[];
    disagreements: string[];
  }): void {
    this.updateState({
      consensusScore: data.score,
      lastUpdate: Date.now(),
    });
  }

  private handleDebateComplete(result: DebateResult): void {
    this.updateState({
      status: 'completed',
      consensusScore: result.finalConsensusScore,
      lastUpdate: Date.now(),
    });
  }

  private handleError(data: { message: string }): void {
    this.updateState({
      status: 'error',
      error: data.message,
    });
  }

  /**
   * Calculate simple text similarity
   */
  private calculateSimilarity(text1: string, text2: string): number {
    const words1 = new Set(text1.toLowerCase().split(/\s+/));
    const words2 = new Set(text2.toLowerCase().split(/\s+/));

    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);

    return intersection.size / union.size;
  }

  /**
   * Update state helper
   */
  private updateState(partial: Partial<StreamingDebateState>): void {
    this.state$.next({
      ...this.state$.value,
      ...partial,
    });
  }

  /**
   * Reset state
   */
  reset(): void {
    this.state$.next({ ...INITIAL_STATE });
  }

  /**
   * Get current debate result (for completed debates)
   */
  async getResult(): Promise<DebateResult | null> {
    const sessionId = this.state().sessionId;
    if (!sessionId) return null;

    try {
      const result = await this.ipc.getApi()?.debateGetResult(sessionId);
      return result?.success ? (result.data as DebateResult) : null;
    } catch {
      return null;
    }
  }
}
