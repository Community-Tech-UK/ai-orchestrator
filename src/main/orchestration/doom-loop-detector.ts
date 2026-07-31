/**
 * DoomLoopDetector — WS-A2: result-aware tool-loop protection.
 *
 * AIO observes provider CLI tool events; it cannot veto a tool call inside the
 * CLI process. "Protection" here means: detect suspicious tool-call patterns
 * from the normalized WS-B10 tool observation seam
 * (`toProviderToolUseObservedEvent` / `toProviderToolResultObservedEvent` in
 * `../providers/adapter-runtime-event-bridge.ts`) and emit typed warning
 * events. Callers may additionally auto-interrupt a turn on a 'critical'
 * event, gated behind a setting that defaults OFF (see `toolLoopAutoInterrupt`
 * in `shared/types/settings.types.ts`).
 *
 * Detectors (all run-scoped per instance):
 *  - `repeat-no-progress`: N consecutive (tool, args, result) pairs are
 *    byte-identical. A changed result hash is progress and resets the chain.
 *  - `ping-pong`: the last W completed calls alternate between exactly two
 *    (tool, args) signatures, each with a stable (unchanging) result.
 *  - `runaway`: total tool calls within one turn exceed a large cap.
 *
 * A post-compaction canary arms a stricter `repeat-no-progress` threshold for
 * the M tool calls immediately following a compaction event, since a fresh
 * summary is a common trigger for re-probing already-known state.
 *
 * Warn-once semantics: at most one 'warn' and one 'critical' event per
 * (instance, detector, signature) per turn. 'critical' fires once the count
 * passes `escalationMultiplier × threshold`.
 *
 * Fail-open: an observation missing the hash it needs for a given detector
 * (`argsHash`/`resultHash`) records nothing for that detector — never guesses.
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';

const logger = getLogger('DoomLoopDetector');

export type ToolLoopDetectorKind = 'repeat-no-progress' | 'ping-pong' | 'runaway';
export type ToolLoopSeverity = 'warn' | 'critical';

/** Emitted on the detector's `'tool-loop-detected'` event. */
export interface ToolLoopDetectionEvent {
  instanceId: string;
  detector: ToolLoopDetectorKind;
  severity: ToolLoopSeverity;
  toolName: string;
  count: number;
  windowDescription: string;
}

/** Normalized tool-use observation fed to `recordToolUse`. */
export interface ToolUseObservation {
  toolName: string;
  /** Correlates with the matching `recordToolResult` call. */
  callId?: string;
  /** sha256-derived hash of the stable-serialized arguments (WS-B10 seam). */
  argsHash?: string;
}

/** Normalized tool-result observation fed to `recordToolResult`. */
export interface ToolResultObservation {
  /** Correlates with the matching `recordToolUse` call. */
  callId?: string;
  /** sha256-derived hash of the stable-serialized result (WS-B10 seam). */
  resultHash?: string;
  isError?: boolean;
}

export interface ToolLoopDetectorConfig {
  /** Consecutive identical (tool, args, result) pairs that trigger `repeat-no-progress`. */
  repeatThreshold: number;
  /** Sliding window of completed calls examined for `ping-pong`. */
  pingPongWindow: number;
  /** Total tool calls in one turn that trigger `runaway`. */
  runawayCap: number;
  /** Stricter `repeat-no-progress` threshold while the post-compaction canary is armed. */
  canaryRepeatThreshold: number;
  /** Number of tool calls the post-compaction canary stays armed for. */
  canaryCallWindow: number;
  /** `count >= threshold × escalationMultiplier` escalates 'warn' to 'critical'. */
  escalationMultiplier: number;
}

export const DEFAULT_TOOL_LOOP_DETECTOR_CONFIG: ToolLoopDetectorConfig = {
  repeatThreshold: 3,
  pingPongWindow: 6,
  runawayCap: 200,
  canaryRepeatThreshold: 2,
  canaryCallWindow: 20,
  escalationMultiplier: 2,
};

/** A completed tool call: tool_use paired with its tool_result. */
interface CompletedPair {
  toolName: string;
  argsHash: string;
  resultHash: string;
}

/** A tool_use observation awaiting its matching tool_result. */
interface PendingToolUse {
  toolName: string;
  argsHash: string;
  /** Captured at tool_use time so canary strictness follows the call that started it. */
  canaryActive: boolean;
}

interface InstanceLoopState {
  /** Awaiting a matching `recordToolResult`, keyed by callId. */
  pendingByCallId: Map<string, PendingToolUse>;
  /** Total tool calls recorded this turn (for `runaway`). */
  totalToolCalls: number;
  /** Signature of the most recently completed pair (for `repeat-no-progress`). */
  lastSignature?: string;
  /** Length of the current identical-signature chain. */
  repeatChainLength: number;
  /** Last `pingPongWindow` completed pairs (for `ping-pong`). */
  pingPongWindowBuf: CompletedPair[];
  /** Consecutive qualifying `ping-pong` window evaluations. */
  pingPongStreak: number;
  /** `${detector}:${signature}` keys already warned this turn. */
  warnedSignatures: Set<string>;
  /** `${detector}:${signature}` keys already escalated to critical this turn. */
  criticalSignatures: Set<string>;
  /** Idempotency guard: an auto-interrupt has already fired for this turn. */
  autoInterrupted: boolean;
  /** Remaining tool calls for which the post-compaction canary applies. */
  canaryCallsRemaining: number;
}

function createInstanceLoopState(): InstanceLoopState {
  return {
    pendingByCallId: new Map(),
    totalToolCalls: 0,
    lastSignature: undefined,
    repeatChainLength: 0,
    pingPongWindowBuf: [],
    pingPongStreak: 0,
    warnedSignatures: new Set(),
    criticalSignatures: new Set(),
    autoInterrupted: false,
    canaryCallsRemaining: 0,
  };
}

/** Reset the turn-scoped fields; the canary countdown deliberately survives turn boundaries. */
function resetTurnScopedFields(state: InstanceLoopState): void {
  state.pendingByCallId.clear();
  state.totalToolCalls = 0;
  state.lastSignature = undefined;
  state.repeatChainLength = 0;
  state.pingPongWindowBuf = [];
  state.pingPongStreak = 0;
  state.warnedSignatures.clear();
  state.criticalSignatures.clear();
  state.autoInterrupted = false;
}

function signatureOf(toolName: string, argsHash: string): string {
  return `${toolName} ${argsHash}`;
}

export class DoomLoopDetector extends EventEmitter {
  private static instance: DoomLoopDetector | null = null;

  private readonly config: ToolLoopDetectorConfig;
  private states = new Map<string, InstanceLoopState>();

  static getInstance(): DoomLoopDetector {
    if (!this.instance) {
      this.instance = new DoomLoopDetector();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.states.clear();
      this.instance.removeAllListeners();
      this.instance = null;
    }
  }

  constructor(config: Partial<ToolLoopDetectorConfig> = {}) {
    super();
    this.config = { ...DEFAULT_TOOL_LOOP_DETECTOR_CONFIG, ...config };
  }

  // ============ Observation ingress ============

  /**
   * Records a tool_use observation. Always counts toward the `runaway` cap.
   * Fail-open: without both `callId` and `argsHash`, nothing is recorded for
   * `repeat-no-progress` / `ping-pong` (they need a matching tool_result).
   */
  recordToolUse(instanceId: string, observation: ToolUseObservation): ToolLoopDetectionEvent[] {
    const state = this.getOrCreateState(instanceId);
    const events: ToolLoopDetectionEvent[] = [];

    state.totalToolCalls++;
    events.push(...this.checkRunaway(instanceId, state, observation.toolName));

    const canaryActive = state.canaryCallsRemaining > 0;
    if (canaryActive) state.canaryCallsRemaining--;

    if (observation.callId !== undefined && observation.argsHash !== undefined) {
      state.pendingByCallId.set(observation.callId, {
        toolName: observation.toolName,
        argsHash: observation.argsHash,
        canaryActive,
      });
    }
    // else: fail-open — no callId/argsHash means the pair can never be
    // completed reliably, so repeat-no-progress/ping-pong skip this call.

    this.emitAll(events);
    return events;
  }

  /**
   * Records a tool_result observation. Fail-open: without both `callId` and
   * `resultHash`, or without a matching pending tool_use, nothing is recorded.
   */
  recordToolResult(instanceId: string, observation: ToolResultObservation): ToolLoopDetectionEvent[] {
    const state = this.getOrCreateState(instanceId);

    if (observation.callId === undefined || observation.resultHash === undefined) {
      if (observation.callId !== undefined) state.pendingByCallId.delete(observation.callId);
      return [];
    }

    const pending = state.pendingByCallId.get(observation.callId);
    state.pendingByCallId.delete(observation.callId);
    if (!pending) return [];

    const pair: CompletedPair = {
      toolName: pending.toolName,
      argsHash: pending.argsHash,
      resultHash: observation.resultHash,
    };

    const events: ToolLoopDetectionEvent[] = [
      ...this.checkRepeatNoProgress(instanceId, state, pair, pending.canaryActive),
      ...this.checkPingPong(instanceId, state, pair),
    ];

    this.emitAll(events);
    return events;
  }

  // ============ Turn / compaction lifecycle ============

  /** Reset turn-scoped chains/warn-once state. Called at the start of a new turn. */
  notifyTurnStart(instanceId: string): void {
    const state = this.states.get(instanceId);
    if (!state) return;
    resetTurnScopedFields(state);
  }

  /** Reset turn-scoped chains/warn-once state. Called when a turn settles. */
  notifyTurnEnd(instanceId: string): void {
    const state = this.states.get(instanceId);
    if (!state) return;
    resetTurnScopedFields(state);
  }

  /** Arm the post-compaction canary: the next `canaryCallWindow` tool calls use a stricter repeat threshold. */
  notifyCompaction(instanceId: string): void {
    const state = this.getOrCreateState(instanceId);
    state.canaryCallsRemaining = this.config.canaryCallWindow;
    logger.info('Tool loop canary armed after compaction', {
      instanceId,
      window: this.config.canaryCallWindow,
    });
  }

  // ============ Auto-interrupt idempotency ============

  /** True once an auto-interrupt has already fired for the instance's current turn. */
  hasAutoInterruptedThisTurn(instanceId: string): boolean {
    return this.states.get(instanceId)?.autoInterrupted ?? false;
  }

  /** Marks the current turn as having already auto-interrupted (idempotency guard for callers). */
  markAutoInterrupted(instanceId: string): void {
    this.getOrCreateState(instanceId).autoInterrupted = true;
  }

  // ============ Cleanup ============

  /** Removes all tracking for a terminated instance. */
  cleanupInstance(instanceId: string): void {
    this.states.delete(instanceId);
    logger.debug('Tool loop tracking cleaned up', { instanceId });
  }

  // ============ Detectors ============

  private checkRunaway(instanceId: string, state: InstanceLoopState, toolName: string): ToolLoopDetectionEvent[] {
    return this.evaluateThreshold(
      instanceId,
      state,
      'runaway',
      toolName,
      'turn-total',
      state.totalToolCalls,
      this.config.runawayCap,
      `${this.config.runawayCap} tool calls in one turn`,
    );
  }

  private checkRepeatNoProgress(
    instanceId: string,
    state: InstanceLoopState,
    pair: CompletedPair,
    canaryActive: boolean,
  ): ToolLoopDetectionEvent[] {
    const signature = `${pair.toolName} ${pair.argsHash} ${pair.resultHash}`;
    if (state.lastSignature === signature) {
      state.repeatChainLength++;
    } else {
      state.lastSignature = signature;
      state.repeatChainLength = 1;
    }

    const threshold = canaryActive ? this.config.canaryRepeatThreshold : this.config.repeatThreshold;
    const windowDescription = canaryActive
      ? `${threshold} consecutive identical calls (post-compaction canary)`
      : `${threshold} consecutive identical calls`;

    return this.evaluateThreshold(
      instanceId,
      state,
      'repeat-no-progress',
      pair.toolName,
      signature,
      state.repeatChainLength,
      threshold,
      windowDescription,
    );
  }

  private checkPingPong(instanceId: string, state: InstanceLoopState, pair: CompletedPair): ToolLoopDetectionEvent[] {
    const window = this.config.pingPongWindow;
    state.pingPongWindowBuf.push(pair);
    if (state.pingPongWindowBuf.length > window) {
      state.pingPongWindowBuf.splice(0, state.pingPongWindowBuf.length - window);
    }

    const qualifies = this.isAlternatingStableWindow(state.pingPongWindowBuf, window);
    state.pingPongStreak = qualifies ? state.pingPongStreak + 1 : 0;
    if (state.pingPongStreak === 0) return [];

    const count = window - 1 + state.pingPongStreak;
    const distinctSigs = [...new Set(state.pingPongWindowBuf.map((p) => signatureOf(p.toolName, p.argsHash)))].sort();
    const signature = distinctSigs.join('|');
    const toolLabel = [...new Set(state.pingPongWindowBuf.map((p) => p.toolName))].join('/');

    return this.evaluateThreshold(
      instanceId,
      state,
      'ping-pong',
      toolLabel,
      signature,
      count,
      window,
      `${window}-call alternating window with unchanged results`,
    );
  }

  private isAlternatingStableWindow(buf: CompletedPair[], window: number): boolean {
    if (buf.length < window) return false;

    const sigs = buf.map((p) => signatureOf(p.toolName, p.argsHash));
    if (new Set(sigs).size !== 2) return false;

    for (let i = 1; i < sigs.length; i++) {
      if (sigs[i] === sigs[i - 1]) return false;
    }

    const resultBySig = new Map<string, string>();
    for (let i = 0; i < buf.length; i++) {
      const sig = sigs[i];
      const seenResult = resultBySig.get(sig);
      if (seenResult !== undefined && seenResult !== buf[i].resultHash) return false;
      resultBySig.set(sig, buf[i].resultHash);
    }

    return true;
  }

  // ============ Shared warn/critical bookkeeping ============

  private evaluateThreshold(
    instanceId: string,
    state: InstanceLoopState,
    detector: ToolLoopDetectorKind,
    toolName: string,
    signature: string,
    count: number,
    threshold: number,
    windowDescription: string,
  ): ToolLoopDetectionEvent[] {
    if (count < threshold) return [];

    const key = `${detector}:${signature}`;
    const criticalThreshold = threshold * this.config.escalationMultiplier;
    const events: ToolLoopDetectionEvent[] = [];

    if (count >= criticalThreshold) {
      if (!state.criticalSignatures.has(key)) {
        state.criticalSignatures.add(key);
        events.push({ instanceId, detector, severity: 'critical', toolName, count, windowDescription });
        logger.warn('Tool loop critical', { instanceId, detector, toolName, count });
      }
    } else if (!state.warnedSignatures.has(key)) {
      state.warnedSignatures.add(key);
      events.push({ instanceId, detector, severity: 'warn', toolName, count, windowDescription });
      logger.warn('Tool loop warning', { instanceId, detector, toolName, count });
    }

    return events;
  }

  private emitAll(events: ToolLoopDetectionEvent[]): void {
    for (const event of events) {
      this.emit('tool-loop-detected', event);
    }
  }

  private getOrCreateState(instanceId: string): InstanceLoopState {
    let state = this.states.get(instanceId);
    if (!state) {
      state = createInstanceLoopState();
      this.states.set(instanceId, state);
    }
    return state;
  }
}

export function getDoomLoopDetector(): DoomLoopDetector {
  return DoomLoopDetector.getInstance();
}
