/**
 * SessionAdmissionService — Phase A gate for automated (non-user) writes into
 * an instance's session, plus an observe-only receipt for ordinary user sends.
 *
 * Problem this closes (A5): several main-process writers call
 * `InstanceManager.sendInput()` on a background timer/event without checking
 * whether the target instance can actually accept input right now (e.g. it is
 * `waiting_for_permission`, mid-interrupt, respawning, or quota-parked). That
 * either throws past the caller or, worse, silently wedges the instance.
 *
 * Design:
 *  - `admitAutomatedWrite()` re-reads LIVE instance state synchronously,
 *    in-memory, with NO SQLite dependency on the safety decision itself — the
 *    store (`SessionAdmissionStore`) is an additive audit trail only. A store
 *    failure must never flip a decision from suppressed to admitted or vice
 *    versa.
 *  - The returned {@link AdmissionOutcome} is a discriminated union whose
 *    zero/default value reads as suppression: a forgotten `if (outcome.kind
 *    === 'admitted')` branch drops the send, it never accidentally sends.
 *  - `recordUserSend()` is a fire-and-forget observability hook for the
 *    ordinary `sendInput()` path — it must never add latency or a new failure
 *    mode, so every store call is wrapped and swallowed.
 *  - Redelivery is event-driven off the same `instance:state-update` /
 *    `instance:batch-update` events the mobile input queue drains on — no
 *    polling loop. A suppressed write's full payload (including attachments)
 *    lives only in the in-memory `pendingRedeliveries` map; like the mobile
 *    queue, it does not survive a restart. The persisted store row only ever
 *    holds lightweight attachment refs (name/type/size), never raw data.
 */

import { getLogger } from '../logging/logger';
import { generateId } from '../../shared/utils/id-generator';
import { getRLMDatabase } from '../persistence/rlm-database';
import {
  SessionAdmissionStore,
  type AdmissionState,
} from './session-admission-store';
import type { FileAttachment, InstanceStatus, InstanceWaitReason } from '../../shared/types/instance.types';

const logger = getLogger('SessionAdmissionService');

/** Statuses a redelivery ready-edge listens for (mirrors mobile-input-queue's READY_STATUSES). */
const READY_STATUSES = new Set<string>(['idle', 'ready', 'waiting_for_input']);

/**
 * Window `recordUserSend()` searches for a matching `promoting` row (Phase B
 * durable queue handoff) before inserting a fresh audit row. Real promotions
 * are followed by `sendInput()` within milliseconds, so this only needs to
 * outlast normal IPC round-trip jitter.
 */
const PROMOTED_SEND_MATCH_WINDOW_MS = 30_000;
const MAX_COALESCED_MESSAGE_CHARS = 20_000;

/** Origins for AUTOMATED writers routed through {@link admitAutomatedWrite}. */
export type AdmissionOrigin =
  | 'channel'
  | 'automation'
  | 'reaction'
  | 'consensus'
  | 'lsp-feedback'
  | 'browser-gateway';

/** Origin values accepted by the store, including the observe-only user path. */
export type AdmissionRowOrigin = AdmissionOrigin | 'user';

export type SuppressReason =
  | 'awaiting-human'
  | 'interrupting'
  | 'respawning'
  | 'not-ready'
  | 'active-turn'
  | 'quota-parked'
  | 'auth-required'
  | 'terminal'
  | 'unknown-instance';

/**
 * Discriminated union whose default/zero value is suppression. Callers MUST
 * check `outcome.kind === 'admitted'` before sending — a forgotten branch, an
 * exhaustiveness bug, or a mis-typed comparison all read as "not sent".
 */
export type AdmissionOutcome =
  | { kind: 'suppressed'; reason: SuppressReason; admissionId: string }
  | { kind: 'admitted'; admissionId: string };

export interface AdmitAutomatedWriteRequest {
  instanceId: string;
  origin: AdmissionOrigin;
  message: string;
  attachments?: FileAttachment[];
  contextBlock?: string;
  sourceMetadata?: Record<string, unknown>;
  /**
   * Opt-in for writers that start a new provider turn. Unlike tool-result-style
   * injections, these writes must wait for both a ready lifecycle status and
   * an idle provider-owned runtime.
   */
  requireReadyForInput?: boolean;
  /** Combine pending message bodies with the same instance/origin/key. */
  coalesceKey?: string;
}

/** Payload handed to a registered redelivery handler on a ready edge. */
export interface RedeliveryContext {
  admissionId: string;
  instanceId: string;
  message: string;
  attachments?: FileAttachment[];
  contextBlock?: string;
  sourceMetadata?: Record<string, unknown>;
}

export type RedeliveryHandler = (ctx: RedeliveryContext) => void | Promise<void>;

/** Minimal slice of `Instance` the admission decision reasons about. */
export interface AdmissionInstanceView {
  status: InstanceStatus;
  waitReason?: InstanceWaitReason;
  interruptPhase?: string;
}

interface AdmissionRuntimeAdapter {
  getRuntimeSnapshot?(): {
    activeTurnId?: string | null;
    turnPhase?: string;
  };
}

/**
 * Minimal InstanceManager surface this service depends on. Kept loose
 * (string event names) to avoid a hard dependency on the concrete
 * InstanceManager EventEmitter typings, matching the `setInstanceManager()`
 * injection idiom used by ChannelMessageRouter / CrossModelReviewService /
 * SessionContinuityManager.
 */
export interface SessionAdmissionInstanceHost {
  getInstance(instanceId: string): AdmissionInstanceView | undefined;
  getAdapter?(instanceId: string): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off?(event: string, listener: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
}

interface PendingRedelivery {
  instanceId: string;
  origin: AdmissionOrigin;
  message: string;
  attachments?: FileAttachment[];
  contextBlock?: string;
  sourceMetadata?: Record<string, unknown>;
  requireReadyForInput?: boolean;
  coalesceKey?: string;
}

function toAttachmentRefs(attachments?: FileAttachment[]): string[] {
  if (!attachments || attachments.length === 0) return [];
  return attachments.map((a) => `${a.name}:${a.type}:${a.size}`);
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SessionAdmissionService {
  private static instance: SessionAdmissionService | null = null;

  private instanceManager: SessionAdmissionInstanceHost | null = null;
  private redeliveryHandlers = new Map<AdmissionOrigin, RedeliveryHandler>();
  private pendingRedeliveries = new Map<string, PendingRedelivery>();

  private readonly onStateUpdate = (payload: unknown): void => this.handleStateUpdate(payload);
  private readonly onBatchUpdate = (payload: unknown): void => this.handleBatchUpdate(payload);
  private readonly onInstanceRemoved = (instanceId: unknown): void => {
    if (typeof instanceId === 'string') this.handleInstanceRemoved(instanceId);
  };

  static getInstance(): SessionAdmissionService {
    if (!SessionAdmissionService.instance) {
      SessionAdmissionService.instance = new SessionAdmissionService();
    }
    return SessionAdmissionService.instance;
  }

  /** Reset the singleton for test isolation. */
  static _resetForTesting(): void {
    SessionAdmissionService.instance?.detachInstanceManager();
    SessionAdmissionService.instance = null;
  }

  // ---- Wiring ----------------------------------------------------------

  /** Inject the live InstanceManager. Called once from main-process startup (and tests). */
  setInstanceManager(im: SessionAdmissionInstanceHost): void {
    this.detachInstanceManager();
    this.instanceManager = im;
    im.on('instance:state-update', this.onStateUpdate);
    im.on('instance:batch-update', this.onBatchUpdate);
    im.on('instance:removed', this.onInstanceRemoved);
    this.sweep();
  }

  private detachInstanceManager(): void {
    if (this.instanceManager) {
      const off = this.instanceManager.off ?? this.instanceManager.removeListener;
      off?.call(this.instanceManager, 'instance:state-update', this.onStateUpdate);
      off?.call(this.instanceManager, 'instance:batch-update', this.onBatchUpdate);
      off?.call(this.instanceManager, 'instance:removed', this.onInstanceRemoved);
    }
    this.instanceManager = null;
  }

  /** Register the redelivery callback for one origin. Last registration wins. */
  registerRedeliveryHandler(origin: AdmissionOrigin, handler: RedeliveryHandler): void {
    this.redeliveryHandlers.set(origin, handler);
  }

  private getStore(): SessionAdmissionStore | null {
    try {
      return SessionAdmissionStore.getInstance(getRLMDatabase().getRawDb());
    } catch (err) {
      logger.warn('SessionAdmissionStore unavailable (fail-soft)', { error: errorMessageOf(err) });
      return null;
    }
  }

  // ---- Core admission decision ------------------------------------------

  private decide(
    instanceId: string,
    requireReadyForInput = false,
  ): { kind: 'admitted' } | { kind: 'suppressed'; reason: SuppressReason } {
    if (!this.instanceManager) {
      logger.warn('admitAutomatedWrite called before setInstanceManager(); suppressing', { instanceId });
      return { kind: 'suppressed', reason: 'unknown-instance' };
    }
    const instance = this.instanceManager.getInstance(instanceId);
    if (!instance) {
      return { kind: 'suppressed', reason: 'unknown-instance' };
    }
    if (instance.status === 'waiting_for_permission') {
      return { kind: 'suppressed', reason: 'awaiting-human' };
    }
    if (
      instance.status === 'interrupting'
      || instance.status === 'cancelling'
      || instance.status === 'interrupt-escalating'
    ) {
      return { kind: 'suppressed', reason: 'interrupting' };
    }
    if (instance.status === 'respawning') {
      return { kind: 'suppressed', reason: 'respawning' };
    }
    if (instance.status === 'error' || instance.status === 'terminated') {
      return { kind: 'suppressed', reason: 'terminal' };
    }
    if (instance.waitReason?.kind === 'quota-park') {
      return { kind: 'suppressed', reason: 'quota-parked' };
    }
    if (instance.waitReason?.kind === 'auth-required') {
      return { kind: 'suppressed', reason: 'auth-required' };
    }
    if (instance.interruptPhase === 'requested' || instance.interruptPhase === 'accepted') {
      return { kind: 'suppressed', reason: 'interrupting' };
    }
    if (requireReadyForInput && !READY_STATUSES.has(instance.status)) {
      return { kind: 'suppressed', reason: 'not-ready' };
    }
    if (requireReadyForInput) {
      const adapter = this.instanceManager.getAdapter?.(instanceId) as
        | AdmissionRuntimeAdapter
        | undefined;
      const snapshot = adapter?.getRuntimeSnapshot?.();
      if (
        snapshot?.activeTurnId
        || snapshot?.turnPhase === 'starting'
        || snapshot?.turnPhase === 'running'
        || snapshot?.turnPhase === 'interrupting'
      ) {
        return { kind: 'suppressed', reason: 'active-turn' };
      }
    }
    return { kind: 'admitted' };
  }

  /**
   * Gate an automated (non-user) write. Re-reads live instance state
   * synchronously; the caller performs its own existing send exactly as
   * before ONLY when `outcome.kind === 'admitted'`. Never sends anything
   * itself.
   */
  admitAutomatedWrite(request: AdmitAutomatedWriteRequest): AdmissionOutcome {
    const decision = this.decide(request.instanceId, request.requireReadyForInput);
    const admissionId = this.persist({
      admissionId: generateId(),
      instanceId: request.instanceId,
      origin: request.origin,
      message: request.message,
      attachments: request.attachments,
      contextBlock: request.contextBlock,
      sourceMetadata: request.sourceMetadata,
      state: decision.kind === 'admitted' ? 'recorded' : 'suppressed',
      suppressReason: decision.kind === 'suppressed' ? decision.reason : undefined,
    });

    if (decision.kind === 'suppressed') {
      this.rememberForRedelivery(admissionId, request);
      logger.info('Automated write suppressed', {
        instanceId: request.instanceId,
        origin: request.origin,
        reason: decision.reason,
        admissionId,
      });
      return { kind: 'suppressed', reason: decision.reason, admissionId };
    }
    return { kind: 'admitted', admissionId };
  }

  private rememberForRedelivery(admissionId: string, request: AdmitAutomatedWriteRequest): void {
    let message = request.message;
    if (request.coalesceKey) {
      for (const [existingId, entry] of this.pendingRedeliveries) {
        if (
          entry.instanceId === request.instanceId
          && entry.origin === request.origin
          && entry.coalesceKey === request.coalesceKey
        ) {
          const combined = entry.message === message ? message : `${entry.message}\n${message}`;
          message = combined.slice(-MAX_COALESCED_MESSAGE_CHARS);
          this.pendingRedeliveries.delete(existingId);
          this.markExpired(existingId);
        }
      }
    }

    // Cap in-memory pending entries per instance (mirrors the store's
    // per-instance cap) so a runaway suppressed writer cannot grow this map
    // unbounded between restarts.
    const existingForInstance = [...this.pendingRedeliveries.entries()].filter(
      ([, e]) => e.instanceId === request.instanceId,
    );
    if (existingForInstance.length >= 50) {
      const [oldestId] = existingForInstance[0];
      this.pendingRedeliveries.delete(oldestId);
      this.markExpired(oldestId);
    }
    this.pendingRedeliveries.set(admissionId, {
      instanceId: request.instanceId,
      origin: request.origin,
      message,
      attachments: request.attachments,
      contextBlock: request.contextBlock,
      sourceMetadata: request.sourceMetadata,
      requireReadyForInput: request.requireReadyForInput,
      coalesceKey: request.coalesceKey,
    });
  }

  // ---- User-send observability -------------------------------------------

  /**
   * Observe-only receipt for the ordinary user `sendInput()` path. Must never
   * add latency or a new failure mode — every store call is caught internally.
   * Returns `null` (instead of throwing) when persistence fails so the caller
   * doesn't need its own try/catch.
   *
   * Dedupe with the Phase B durable queue: `instance-communication.ts` cannot
   * be edited to thread an admissionId through from the renderer's promote
   * call, so this matches on instanceId+message against a recent `promoting`
   * row instead. A match means this send IS the promoted queued message —
   * transition that row to `recorded` in place rather than inserting a
   * second audit row for the same send.
   */
  recordUserSend(
    instanceId: string,
    message: string,
    attachments?: FileAttachment[],
    contextBlock?: string | null,
  ): { admissionId: string } | null {
    try {
      const store = this.getStore();
      if (!store) return { admissionId: generateId() };

      const promoted = store.findRecentPromoting(instanceId, message, PROMOTED_SEND_MATCH_WINDOW_MS);
      if (promoted) {
        store.updateState(promoted.admissionId, 'recorded');
        return { admissionId: promoted.admissionId };
      }

      const admissionId = generateId();
      store.create({
        admissionId,
        instanceId,
        origin: 'user',
        message,
        attachmentRefs: toAttachmentRefs(attachments),
        contextBlock: contextBlock ?? null,
        sourceMetadata: null,
        state: 'recorded',
        suppressReason: null,
      });
      return { admissionId };
    } catch (err) {
      logger.warn('recordUserSend failed (fail-soft)', { instanceId, error: errorMessageOf(err) });
      return null;
    }
  }

  // ---- State transitions --------------------------------------------------

  markDelivered(admissionId: string): void {
    this.pendingRedeliveries.delete(admissionId);
    this.transition(admissionId, 'delivered');
  }

  markFailed(admissionId: string, errorText?: string): void {
    this.pendingRedeliveries.delete(admissionId);
    this.transition(admissionId, 'failed', { errorText });
  }

  private markExpired(admissionId: string): void {
    this.transition(admissionId, 'expired');
  }

  private transition(admissionId: string, state: AdmissionState, extra?: { errorText?: string }): void {
    const store = this.getStore();
    if (!store) return;
    try {
      store.updateState(admissionId, state, extra);
    } catch (err) {
      logger.warn('Failed to update prompt admission state', { admissionId, state, error: errorMessageOf(err) });
    }
  }

  private persist(input: {
    admissionId: string;
    instanceId: string;
    origin: AdmissionRowOrigin;
    message: string;
    attachments?: FileAttachment[];
    contextBlock?: string;
    sourceMetadata?: Record<string, unknown>;
    state: AdmissionState;
    suppressReason?: SuppressReason;
  }): string {
    const store = this.getStore();
    if (!store) return input.admissionId;
    try {
      store.create({
        admissionId: input.admissionId,
        instanceId: input.instanceId,
        origin: input.origin,
        message: input.message,
        attachmentRefs: toAttachmentRefs(input.attachments),
        contextBlock: input.contextBlock ?? null,
        sourceMetadata: input.sourceMetadata ?? null,
        state: input.state,
        suppressReason: input.suppressReason ?? null,
      });
    } catch (err) {
      logger.warn('Failed to persist prompt admission row (fail-soft)', {
        instanceId: input.instanceId,
        origin: input.origin,
        error: errorMessageOf(err),
      });
    }
    return input.admissionId;
  }

  // ---- Redelivery on ready edge -------------------------------------------

  private handleStateUpdate(payload: unknown): void {
    const p = payload as { instanceId?: unknown; status?: unknown } | undefined;
    if (typeof p?.instanceId === 'string' && typeof p.status === 'string' && READY_STATUSES.has(p.status)) {
      this.tryRefire(p.instanceId);
    }
  }

  private handleBatchUpdate(payload: unknown): void {
    const p = payload as { updates?: { instanceId?: unknown; status?: unknown }[] } | undefined;
    for (const u of p?.updates ?? []) {
      if (typeof u.instanceId === 'string' && typeof u.status === 'string' && READY_STATUSES.has(u.status)) {
        this.tryRefire(u.instanceId);
      }
    }
  }

  private handleInstanceRemoved(instanceId: string): void {
    for (const [admissionId, entry] of this.pendingRedeliveries) {
      if (entry.instanceId === instanceId) {
        this.pendingRedeliveries.delete(admissionId);
        this.markExpired(admissionId);
      }
    }
  }

  private tryRefire(instanceId: string): void {
    const candidates = [...this.pendingRedeliveries.entries()].filter(([, e]) => e.instanceId === instanceId);
    if (candidates.length === 0) return;

    for (const [admissionId, entry] of candidates) {
      // Re-decide per entry rather than trusting the ready status alone: a
      // strict new-turn writer also requires the provider runtime to have
      // released ownership, while legacy mid-turn writers retain their
      // existing admission policy.
      const decision = this.decide(instanceId, entry.requireReadyForInput);
      if (decision.kind !== 'admitted') continue;

      const handler = this.redeliveryHandlers.get(entry.origin);
      if (!handler) continue; // left pending; sweep() expires unhandled origins.
      this.pendingRedeliveries.delete(admissionId);
      try {
        const result = handler({
          admissionId,
          instanceId,
          message: entry.message,
          attachments: entry.attachments,
          contextBlock: entry.contextBlock,
          sourceMetadata: entry.sourceMetadata,
        });
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((err: unknown) => {
            logger.warn('Redelivery handler rejected', {
              instanceId, origin: entry.origin, admissionId, error: errorMessageOf(err),
            });
          });
        }
      } catch (err) {
        logger.warn('Redelivery handler threw synchronously', {
          instanceId, origin: entry.origin, admissionId, error: errorMessageOf(err),
        });
      }
    }
  }

  // ---- Maintenance ---------------------------------------------------------

  /**
   * Bounded-retention pass: purges old terminal rows / caps per-instance
   * pending rows in the store (see `SessionAdmissionStore.sweepExpired`), and
   * expires any in-memory suppressed entry whose origin currently has no
   * registered redelivery handler (nothing will ever refire it).
   *
   * Called once from `setInstanceManager()` (startup) — deliberately not on a
   * repeating timer for Phase A.
   */
  sweep(): void {
    const store = this.getStore();
    if (store) {
      try {
        store.sweepExpired();
      } catch (err) {
        logger.warn('SessionAdmissionStore.sweepExpired failed', { error: errorMessageOf(err) });
      }
    }
    for (const [admissionId, entry] of [...this.pendingRedeliveries]) {
      if (!this.redeliveryHandlers.has(entry.origin)) {
        this.pendingRedeliveries.delete(admissionId);
        this.markExpired(admissionId);
      }
    }
  }

  /** Read-only accessor for the IPC handler. */
  listAdmissions(filter: { instanceId?: string; states?: AdmissionState[] } = {}) {
    const store = this.getStore();
    if (!store) return [];
    try {
      return store.list(filter);
    } catch (err) {
      logger.warn('SessionAdmissionStore.list failed', { error: errorMessageOf(err) });
      return [];
    }
  }
}

export function getSessionAdmissionService(): SessionAdmissionService {
  return SessionAdmissionService.getInstance();
}

export function _resetSessionAdmissionServiceForTesting(): void {
  SessionAdmissionService._resetForTesting();
}
