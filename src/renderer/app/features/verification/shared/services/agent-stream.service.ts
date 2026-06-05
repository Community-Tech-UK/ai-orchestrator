/**
 * Agent Stream Service
 *
 * Manages real-time streaming of agent responses:
 * - Track streaming state per agent
 * - Buffer and emit chunks
 * - Handle stream lifecycle
 */

import { Injectable, inject, signal, computed, OnDestroy } from '@angular/core';
import { Subject, BehaviorSubject, Observable } from 'rxjs';
import { takeUntil, filter } from 'rxjs/operators';
import { ElectronIpcService } from '../../../../core/services/ipc';
import { estimateTokens as sharedEstimateTokens } from '../../../../../../shared/utils/token-estimate';

// ============================================
// Types
// ============================================

export type StreamStatus = 'idle' | 'connecting' | 'streaming' | 'paused' | 'complete' | 'error';

export interface AgentStreamState {
  /** Agent ID */
  agentId: string;
  /** Agent display name */
  agentName: string;
  /** Current stream status */
  status: StreamStatus;
  /** Accumulated content */
  content: string;
  /** Content chunks for animation */
  chunks: string[];
  /** Tokens streamed so far */
  tokens: number;
  /** Time started */
  startedAt?: number;
  /** Time completed */
  completedAt?: number;
  /** Error message if failed */
  error?: string;
  /** Is currently receiving chunks */
  isReceiving: boolean;
  /** Last chunk timestamp */
  lastChunkAt?: number;
}

export interface StreamEvent {
  type: 'start' | 'chunk' | 'complete' | 'error' | 'pause' | 'resume';
  agentId: string;
  data?: string | { error: string; tokens?: number };
  timestamp: number;
}

interface StreamsState {
  /** All agent streams by ID */
  streams: Map<string, AgentStreamState>;
  /** Currently active session ID */
  sessionId: string | null;
  /** Overall streaming status */
  overallStatus: StreamStatus;
}

// ============================================
// Initial State
// ============================================

const INITIAL_STATE: StreamsState = {
  streams: new Map(),
  sessionId: null,
  overallStatus: 'idle',
};

// ============================================
// Service
// ============================================

@Injectable({ providedIn: 'root' })
export class AgentStreamService implements OnDestroy {
  private ipc = inject(ElectronIpcService);
  private destroy$ = new Subject<void>();

  // State management
  private state$ = new BehaviorSubject<StreamsState>({ ...INITIAL_STATE, streams: new Map() });

  // Event streams
  private events$ = new Subject<StreamEvent>();

  // Signals for reactive UI
  readonly state = signal<StreamsState>({ ...INITIAL_STATE, streams: new Map() });
  readonly overallStatus = computed(() => this.state().overallStatus);
  readonly isStreaming = computed(() => this.state().overallStatus === 'streaming');
  readonly activeStreamCount = computed(() => {
    const streams = Array.from(this.state().streams.values());
    return streams.filter(s => s.status === 'streaming').length;
  });

  // Computed streams list
  readonly streamsList = computed(() => {
    return Array.from(this.state().streams.values());
  });

  private unsubscribes: (() => void)[] = [];

  constructor() {
    // Sync state$ to signal
    this.state$.pipe(takeUntil(this.destroy$)).subscribe(state => {
      this.state.set(state);
    });

    // Set up IPC listeners
    this.setupIpcListeners();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.unsubscribes.forEach(unsub => unsub());
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Get event stream as Observable
   */
  getEventStream(): Observable<StreamEvent> {
    return this.events$.asObservable();
  }

  /**
   * Get events for a specific agent
   */
  getAgentEvents(agentId: string): Observable<StreamEvent> {
    return this.events$.pipe(filter(event => event.agentId === agentId));
  }

  /**
   * Get stream state for an agent
   */
  getAgentStream(agentId: string): AgentStreamState | undefined {
    return this.state().streams.get(agentId);
  }

  /**
   * Get stream content for an agent
   */
  getAgentContent(agentId: string): string {
    return this.state().streams.get(agentId)?.content || '';
  }

  /**
   * Initialize streaming for a session
   */
  initSession(sessionId: string, agentIds: string[]): void {
    const streams = new Map<string, AgentStreamState>();

    for (const agentId of agentIds) {
      streams.set(agentId, {
        agentId,
        agentName: agentId,
        status: 'idle',
        content: '',
        chunks: [],
        tokens: 0,
        isReceiving: false,
      });
    }

    this.updateState({
      sessionId,
      streams,
      overallStatus: 'idle',
    });
  }

  /**
   * Start streaming for an agent
   */
  startAgentStream(agentId: string, agentName?: string): void {
    const stream = this.state().streams.get(agentId);
    if (!stream) return;

    this.updateAgentStream(agentId, {
      status: 'streaming',
      agentName: agentName || stream.agentName,
      startedAt: Date.now(),
      isReceiving: true,
      content: '',
      chunks: [],
    });

    this.emitEvent({
      type: 'start',
      agentId,
      timestamp: Date.now(),
    });

    // Update overall status
    this.updateOverallStatus();
  }

  /**
   * Append a chunk to an agent's stream
   */
  appendChunk(agentId: string, chunk: string): void {
    const stream = this.state().streams.get(agentId);
    if (!stream) return;

    this.updateAgentStream(agentId, {
      content: stream.content + chunk,
      chunks: [...stream.chunks, chunk],
      lastChunkAt: Date.now(),
      isReceiving: true,
    });

    this.emitEvent({
      type: 'chunk',
      agentId,
      data: chunk,
      timestamp: Date.now(),
    });
  }

  /**
   * Complete an agent's stream
   */
  completeAgentStream(agentId: string, tokens?: number): void {
    const stream = this.state().streams.get(agentId);
    if (!stream) return;

    this.updateAgentStream(agentId, {
      status: 'complete',
      completedAt: Date.now(),
      isReceiving: false,
      tokens: tokens ?? this.estimateTokens(stream.content),
    });

    this.emitEvent({
      type: 'complete',
      agentId,
      data: { error: '', tokens },
      timestamp: Date.now(),
    });

    // Update overall status
    this.updateOverallStatus();
  }

  /**
   * Mark an agent's stream as errored
   */
  errorAgentStream(agentId: string, error: string): void {
    this.updateAgentStream(agentId, {
      status: 'error',
      completedAt: Date.now(),
      isReceiving: false,
      error,
    });

    this.emitEvent({
      type: 'error',
      agentId,
      data: { error },
      timestamp: Date.now(),
    });

    // Update overall status
    this.updateOverallStatus();
  }

  /**
   * Pause an agent's stream
   */
  pauseAgentStream(agentId: string): void {
    this.updateAgentStream(agentId, {
      status: 'paused',
      isReceiving: false,
    });

    this.emitEvent({
      type: 'pause',
      agentId,
      timestamp: Date.now(),
    });
  }

  /**
   * Resume an agent's stream
   */
  resumeAgentStream(agentId: string): void {
    this.updateAgentStream(agentId, {
      status: 'streaming',
      isReceiving: true,
    });

    this.emitEvent({
      type: 'resume',
      agentId,
      timestamp: Date.now(),
    });
  }

  /**
   * Reset all streams
   */
  reset(): void {
    this.updateState({
      ...INITIAL_STATE,
      streams: new Map(),
    });
  }

  /**
   * Get streaming stats
   */
  getStats(): {
    totalAgents: number;
    streaming: number;
    completed: number;
    errored: number;
    totalTokens: number;
    totalChunks: number;
  } {
    const streams = Array.from(this.state().streams.values());

    return {
      totalAgents: streams.length,
      streaming: streams.filter(s => s.status === 'streaming').length,
      completed: streams.filter(s => s.status === 'complete').length,
      errored: streams.filter(s => s.status === 'error').length,
      totalTokens: streams.reduce((sum, s) => sum + s.tokens, 0),
      totalChunks: streams.reduce((sum, s) => sum + s.chunks.length, 0),
    };
  }

  // ============================================
  // Private Methods
  // ============================================

  private setupIpcListeners(): void {
    // Listen for agent stream events from main process
    const unsubStart = this.ipc.getApi()?.onVerificationAgentStart(
      (rawData: unknown) => {
        const data = rawData as { sessionId: string; agentId: string; name: string };
        if (data.sessionId === this.state().sessionId) {
          this.startAgentStream(data.agentId, data.name);
        }
      }
    ) ?? (() => { /* noop */ });
    this.unsubscribes.push(unsubStart);

    const unsubStream = this.ipc.getApi()?.onVerificationAgentStream(
      (rawData: unknown) => {
        const data = rawData as { sessionId: string; agentId: string; chunk: string };
        if (data.sessionId === this.state().sessionId) {
          this.appendChunk(data.agentId, data.chunk);
        }
      }
    ) ?? (() => { /* noop */ });
    this.unsubscribes.push(unsubStream);

    const unsubComplete = this.ipc.getApi()?.onVerificationAgentComplete(
      (rawData: unknown) => {
        const data = rawData as { sessionId: string; response: { agentId: string; tokens?: number } };
        if (data.sessionId === this.state().sessionId) {
          this.completeAgentStream(data.response.agentId, data.response.tokens);
        }
      }
    ) ?? (() => { /* noop */ });
    this.unsubscribes.push(unsubComplete);

    const unsubError = this.ipc.getApi()?.onVerificationAgentError(
      (rawData: unknown) => {
        const data = rawData as { sessionId: string; agentId: string; error: string };
        if (data.sessionId === this.state().sessionId) {
          this.errorAgentStream(data.agentId, data.error);
        }
      }
    ) ?? (() => { /* noop */ });
    this.unsubscribes.push(unsubError);
  }

  private updateState(partial: Partial<StreamsState>): void {
    this.state$.next({
      ...this.state$.value,
      ...partial,
    });
  }

  private updateAgentStream(agentId: string, partial: Partial<AgentStreamState>): void {
    const streams = new Map(this.state$.value.streams);
    const existing = streams.get(agentId);

    if (existing) {
      streams.set(agentId, { ...existing, ...partial });
      this.updateState({ streams });
    }
  }

  private updateOverallStatus(): void {
    const streams = Array.from(this.state().streams.values());
    const statuses = streams.map(s => s.status);

    let overallStatus: StreamStatus;

    if (statuses.every(s => s === 'idle')) {
      overallStatus = 'idle';
    } else if (statuses.some(s => s === 'streaming')) {
      overallStatus = 'streaming';
    } else if (statuses.every(s => s === 'complete' || s === 'error')) {
      overallStatus = statuses.every(s => s === 'complete') ? 'complete' : 'error';
    } else if (statuses.some(s => s === 'paused')) {
      overallStatus = 'paused';
    } else {
      overallStatus = 'streaming';
    }

    this.updateState({ overallStatus });
  }

  private emitEvent(event: StreamEvent): void {
    this.events$.next(event);
  }

  private estimateTokens(content: string): number {
    return sharedEstimateTokens(content);
  }
}
