import { randomUUID } from 'node:crypto';
import type {
  LocalAiFallbackRequest,
  LocalAiFallbackRequestInput,
  LocalAiFallbackResolution,
  LocalAiRoutingEvent,
} from '../../shared/types/local-ai-guard.types';
import { LocalAiFallbackRequestInputSchema } from '../../shared/validation/local-ai-guard.schemas';
import { getLogger } from '../logging/logger';
import type { LocalAiHealthRepository } from './local-ai-health-repository';
import type { LocalAiFallbackReservationLimits } from './local-ai-fallback-store';

interface ApprovalRepository {
  createFallbackRequest(request: LocalAiFallbackRequest): void;
  createFallbackRoutingRequest(
    event: LocalAiRoutingEvent,
    request: LocalAiFallbackRequest,
    limits: LocalAiFallbackReservationLimits,
  ): { event: LocalAiRoutingEvent; request?: LocalAiFallbackRequest };
  resolveFallbackRequest(
    requestId: string,
    resolution: LocalAiFallbackResolution,
    limits?: LocalAiFallbackReservationLimits,
  ): LocalAiFallbackRequest | undefined;
  getFallbackRequest(requestId: string): LocalAiFallbackRequest | undefined;
  listPendingFallbackRequests(): LocalAiFallbackRequest[];
}

interface ApprovalLogger {
  warn(message: string, data?: Record<string, unknown>): void;
}

export interface LocalAiFallbackApprovalServiceOptions {
  now?: () => number;
  createId?: () => string;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
  notifyPending?: (request: LocalAiFallbackRequest) => void;
  logger?: ApprovalLogger;
  pollIntervalMs?: number;
  resolveReservationLimits?: (
    request: LocalAiFallbackRequest,
  ) => LocalAiFallbackReservationLimits | undefined;
}

export interface LocalAiFallbackApprovalCreation {
  routingEvent: LocalAiRoutingEvent;
  reservationLimits: LocalAiFallbackReservationLimits;
}

interface PendingAwaiter {
  resolve(resolution: LocalAiFallbackResolution): void;
  reject(error: Error): void;
  expiresAt: number;
  timer?: unknown;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_POLL_INTERVAL_MS = 250;

export class LocalAiFallbackApprovalService {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelScheduled: (handle: unknown) => void;
  private readonly notifyPending: (request: LocalAiFallbackRequest) => void;
  private readonly logger: ApprovalLogger;
  private readonly pollIntervalMs: number;
  private readonly resolveReservationLimits: (
    request: LocalAiFallbackRequest,
  ) => LocalAiFallbackReservationLimits | undefined;
  private readonly awaiters = new Map<string, PendingAwaiter>();
  private readonly incidentAllowances = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(
    repository: Pick<
      LocalAiHealthRepository,
      | 'createFallbackRequest'
      | 'createFallbackRoutingRequest'
      | 'resolveFallbackRequest'
      | 'getFallbackRequest'
      | 'listPendingFallbackRequests'
    >,
    options: LocalAiFallbackApprovalServiceOptions = {},
  ) {
    this.repository = repository;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.schedule = options.schedule
      ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelScheduled = options.cancelScheduled
      ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.notifyPending = options.notifyPending ?? (() => undefined);
    this.logger = options.logger ?? getLogger('LocalAiFallbackApprovalService');
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.resolveReservationLimits = options.resolveReservationLimits ?? (() => undefined);
    this.sweepRestartOrphans();
  }

  private readonly repository: ApprovalRepository;

  request(
    input: LocalAiFallbackRequestInput,
    creation?: LocalAiFallbackApprovalCreation,
  ): Promise<LocalAiFallbackResolution> {
    if (this.disposed) throw new Error('Local AI fallback approval service is disposed');
    const parsed = LocalAiFallbackRequestInputSchema.parse(input);
    const now = this.currentTimestamp();
    if (parsed.expiresAt <= now) {
      throw new RangeError('Local AI fallback approval expiry must be in the future');
    }
    const request: LocalAiFallbackRequest = {
      ...parsed,
      id: this.createId(),
      status: 'pending',
      createdAt: now,
    };

    if (creation) {
      const created = this.repository.createFallbackRoutingRequest(
        creation.routingEvent,
        request,
        creation.reservationLimits,
      );
      if (!created.request) return Promise.resolve('block');
    } else {
      this.repository.createFallbackRequest(request);
    }

    let settle!: (resolution: LocalAiFallbackResolution) => void;
    let rejectWaiter!: (error: Error) => void;
    const promise = new Promise<LocalAiFallbackResolution>((resolve, reject) => {
      settle = resolve;
      rejectWaiter = reject;
    });
    this.awaiters.set(request.id, {
      resolve: settle,
      reject: rejectWaiter,
      expiresAt: parsed.expiresAt,
    });
    this.armTimeout(request.id);
    try {
      this.notifyPending(request);
    } catch {
      this.logger.warn('Local AI fallback approval notification failed', {
        reason: 'notification-error',
      });
    }
    this.notifyChanged();
    return promise;
  }

  listPending(): LocalAiFallbackRequest[] {
    return this.repository.listPendingFallbackRequests();
  }

  resolve(
    requestId: string,
    decision: LocalAiFallbackResolution,
  ): LocalAiFallbackRequest {
    if (this.disposed) throw new Error('Local AI fallback approval service is disposed');
    const pending = this.repository.getFallbackRequest(requestId);
    const limits = pending ? this.resolveReservationLimits(pending) : undefined;
    const request = this.repository.resolveFallbackRequest(requestId, decision, limits);
    if (!request?.resolution) throw new Error(`Local AI fallback request not found: ${requestId}`);
    this.installIncidentAllowance(request);
    this.settle(requestId, request.resolution);
    this.notifyChanged();
    return request;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  hasIncidentAllowance(incidentId: string): boolean {
    return this.incidentAllowances.has(incidentId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const requestId of [...this.awaiters.keys()]) {
      try {
        const request = this.repository.resolveFallbackRequest(requestId, 'block');
        if (!request?.resolution) throw new Error(`Local AI fallback request not found: ${requestId}`);
        this.settle(requestId, request.resolution);
      } catch (error) {
        this.logger.warn('Local AI fallback approval disposal persistence failed', {
          reason: 'repository-error',
        });
        this.reject(requestId, error);
      }
    }
    this.incidentAllowances.clear();
    this.listeners.clear();
  }

  private sweepRestartOrphans(): void {
    for (;;) {
      const pending = this.repository.listPendingFallbackRequests();
      if (!pending.length) return;
      let transitioned = 0;
      for (const request of pending) {
        const resolved = this.repository.resolveFallbackRequest(request.id, 'block');
        if (resolved?.status !== 'pending') transitioned += 1;
      }
      if (transitioned === 0) {
        throw new Error('Local AI fallback restart sweep made no durable progress');
      }
    }
  }

  private timeout(requestId: string): void {
    const awaiter = this.awaiters.get(requestId);
    if (!awaiter) return;
    try {
      const stored = this.repository.getFallbackRequest(requestId);
      if (!stored) {
        this.reject(requestId, new Error(`Local AI fallback request not found: ${requestId}`));
        return;
      }
      if (stored.status !== 'pending') {
        if (!stored.resolution) {
          this.reject(requestId, new Error(`Local AI fallback request has no resolution: ${requestId}`));
          return;
        }
        this.installIncidentAllowance(stored);
        this.settle(requestId, stored.resolution);
        this.notifyChanged();
        return;
      }
      if (this.currentTimestamp() >= awaiter.expiresAt) {
        const resolved = this.repository.resolveFallbackRequest(requestId, 'block');
        if (!resolved?.resolution) {
          this.reject(requestId, new Error(`Local AI fallback request did not resolve: ${requestId}`));
          return;
        }
        this.installIncidentAllowance(resolved);
        this.settle(requestId, resolved.resolution);
        this.notifyChanged();
        return;
      }
      this.armTimeout(requestId);
    } catch (error) {
      this.logger.warn('Local AI fallback approval expiry persistence failed', {
        reason: 'repository-error',
      });
      this.reject(requestId, error);
    }
  }

  private settle(requestId: string, resolution: LocalAiFallbackResolution): void {
    const awaiter = this.awaiters.get(requestId);
    if (!awaiter) return;
    this.awaiters.delete(requestId);
    if (awaiter.timer !== undefined) this.cancelScheduled(awaiter.timer);
    awaiter.resolve(resolution);
  }

  private reject(requestId: string, error: unknown): void {
    const awaiter = this.awaiters.get(requestId);
    if (!awaiter) return;
    this.awaiters.delete(requestId);
    if (awaiter.timer !== undefined) this.cancelScheduled(awaiter.timer);
    awaiter.reject(error instanceof Error ? error : new Error(String(error)));
  }

  private installIncidentAllowance(request: LocalAiFallbackRequest): void {
    if (request.resolution === 'allow-incident' && request.incidentId) {
      this.incidentAllowances.add(request.incidentId);
    }
  }

  private armTimeout(requestId: string): void {
    const awaiter = this.awaiters.get(requestId);
    if (!awaiter) return;
    const remaining = Math.max(0, awaiter.expiresAt - this.currentTimestamp());
    awaiter.timer = this.schedule(
      () => this.timeout(requestId),
      Math.min(MAX_TIMER_DELAY_MS, this.pollIntervalMs, remaining),
    );
  }

  private currentTimestamp(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError('Local AI fallback approval clock returned an invalid timestamp');
    }
    return now;
  }

  private notifyChanged(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        this.logger.warn('Local AI fallback listener failed', { reason: 'listener-error' });
      }
    }
  }
}
