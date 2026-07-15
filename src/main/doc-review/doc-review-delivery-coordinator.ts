import { randomUUID } from 'node:crypto';
import type {
  DocReviewDeliveryAttempt,
  DocReviewSession,
} from '@contracts/schemas/doc-review';
import type { DocReviewDeliveryCoordinator as DeliveryPort } from './doc-review.types';

interface InstanceView {
  id: string;
  status: string;
  historyThreadId?: string;
  sessionId?: string;
  providerSessionId?: string;
}

type InstanceManagerPort = {
  getInstance(instanceId: string): InstanceView | undefined;
  getAllInstances?(): InstanceView[];
  sendInput(instanceId: string, message: string): Promise<void>;
  wakeInstance(instanceId: string): Promise<void>;
  reviveFromContinuity(request: {
    sourceInstanceId: string;
    initialPrompt: string;
    reason: 'doc-review-submission';
  }): Promise<{ instanceId: string; restoreMode: 'native' | 'replay' }>;
  on?(event: 'instance:state-changed', listener: (event: unknown) => void): unknown;
  off?(event: 'instance:state-changed', listener: (event: unknown) => void): unknown;
};

interface PauseCoordinatorPort {
  isPaused(): boolean;
  on?(event: 'resume', listener: () => void): unknown;
  off?(event: 'resume', listener: () => void): unknown;
}

interface LoopCoordinatorPort {
  getLoop(loopRunId: string): {
    status: string;
    lastCompletionOutcome?: string;
    terminalIntentPending?: { kind?: string };
  } | undefined;
  acceptCompletion(loopRunId: string): boolean | Promise<boolean>;
  intervene(loopRunId: string, message: string): boolean | Promise<boolean>;
  resumeLoop(loopRunId: string): boolean | Promise<boolean>;
}

export interface DocReviewDeliveryCoordinatorDeps {
  instanceManager: InstanceManagerPort;
  pauseCoordinator: PauseCoordinatorPort;
  loopCoordinator: LoopCoordinatorPort;
  resumeOnSubmit(): boolean;
  recordRecoveredAttempt(reviewId: string, attempt: DocReviewDeliveryAttempt): void;
}

interface QueuedDelivery {
  session: DocReviewSession;
  feedback: string;
}

const SETTLED_STATUSES = new Set(['idle', 'ready', 'waiting_for_input']);
const REVIVABLE_STATUSES = new Set(['terminated', 'failed', 'error', 'cancelled', 'superseded']);

/**
 * Lifecycle-aware delivery policy. Persistence remains with DocReviewService;
 * this coordinator only returns (or later reports) evidence of delivery.
 */
export class DocReviewDeliveryCoordinator implements DeliveryPort {
  private readonly queued = new Map<string, QueuedDelivery[]>();
  private readonly queuedAttempts = new Map<string, DocReviewDeliveryAttempt>();
  private readonly inFlight = new Map<string, Promise<DocReviewDeliveryAttempt>>();
  private readonly draining = new Map<string, Promise<void>>();
  private readonly onStateChanged = (event: unknown): void => {
    const data = event as { instanceId?: unknown; status?: unknown };
    if (
      typeof data.instanceId !== 'string'
      || typeof data.status !== 'string'
      || !SETTLED_STATUSES.has(data.status)
    ) return;
    for (const [conversationKey, deliveries] of this.queued) {
      if (deliveries.some((delivery) => this.resolveCurrentInstance(delivery.session)?.id === data.instanceId)) {
        this.scheduleDrain(conversationKey);
      }
    }
  };
  private readonly onPauseResume = (): void => {
    for (const conversationKey of this.queued.keys()) this.scheduleDrain(conversationKey);
  };

  constructor(private readonly deps: DocReviewDeliveryCoordinatorDeps) {
    deps.instanceManager.on?.('instance:state-changed', this.onStateChanged);
    deps.pauseCoordinator.on?.('resume', this.onPauseResume);
  }

  async deliver(session: DocReviewSession, feedback: string): Promise<DocReviewDeliveryAttempt> {
    const ongoing = this.inFlight.get(session.id);
    if (ongoing) return ongoing;
    const delivery = this.deliverOnce(session, feedback);
    this.inFlight.set(session.id, delivery);
    try {
      return await delivery;
    } finally {
      if (this.inFlight.get(session.id) === delivery) this.inFlight.delete(session.id);
    }
  }

  dispose(): void {
    this.deps.instanceManager.off?.('instance:state-changed', this.onStateChanged);
    this.deps.pauseCoordinator.off?.('resume', this.onPauseResume);
  }

  private async deliverOnce(session: DocReviewSession, feedback: string): Promise<DocReviewDeliveryAttempt> {
    if (session.origin?.kind === 'loop') return this.deliverLoop(session, feedback);
    if (this.deps.pauseCoordinator.isPaused()) return this.queue(session, feedback, 'await-idle');

    const current = this.resolveCurrentInstance(session);
    if (current && SETTLED_STATUSES.has(current.status)) {
      return this.send(current.id, feedback, 'direct-send');
    }
    if (current?.status === 'hibernated') {
      try {
        await this.deps.instanceManager.wakeInstance(current.id);
        return this.send(current.id, feedback, 'wake');
      } catch (error) {
        return this.failed('wake', error, current.id);
      }
    }
    if (current && !REVIVABLE_STATUSES.has(current.status)) {
      return this.queue(session, feedback, 'deferred-idle', current.id);
    }
    return this.revive(session, feedback);
  }

  private async revive(session: DocReviewSession, feedback: string): Promise<DocReviewDeliveryAttempt> {
    if (!this.deps.resumeOnSubmit()) {
      return this.failed('continuity-revive', 'Automatic review-session revival is disabled in settings.');
    }
    try {
      const revived = await this.deps.instanceManager.reviveFromContinuity({
        sourceInstanceId: session.origin?.kind === 'instance'
          ? session.origin.requestedInstanceId
          : session.instanceId,
        initialPrompt: feedback,
        reason: 'doc-review-submission',
      });
      return this.attempt('delivered', 'continuity-revive', { targetInstanceId: revived.instanceId });
    } catch (error) {
      return this.failed('continuity-revive', error);
    }
  }

  private async deliverLoop(session: DocReviewSession, feedback: string): Promise<DocReviewDeliveryAttempt> {
    const origin = session.origin;
    if (!origin || origin.kind !== 'loop') return this.failed('none', 'Missing loop origin.');
    const loop = this.deps.loopCoordinator.getLoop(origin.loopRunId);
    if (!loop || loop.status !== 'paused') {
      return this.failed('none', 'The associated loop is no longer paused at a review gate.');
    }
    if (session.status === 'approved') {
      const eligible = loop.lastCompletionOutcome === 'unverifiable'
        || loop.terminalIntentPending?.kind === 'complete';
      if (!eligible) {
        return this.failed('loop-accept', 'The paused loop is not awaiting completion acceptance.');
      }
      const accepted = await this.deps.loopCoordinator.acceptCompletion(origin.loopRunId);
      return accepted
        ? this.attempt('delivered', 'loop-accept')
        : this.failed('loop-accept', 'Loop refused the review acceptance.');
    }
    const intervened = await this.deps.loopCoordinator.intervene(origin.loopRunId, feedback);
    if (!intervened) return this.failed('loop-intervene', 'Loop refused the review intervention.');
    const resumed = await this.deps.loopCoordinator.resumeLoop(origin.loopRunId);
    return resumed
      ? this.attempt('delivered', 'loop-intervene')
      : this.failed('loop-intervene', 'Loop could not resume after the review intervention.');
  }

  private queue(
    session: DocReviewSession,
    feedback: string,
    mechanism: 'await-idle' | 'deferred-idle',
    targetInstanceId = this.resolveCurrentInstance(session)?.id ?? session.instanceId,
  ): DocReviewDeliveryAttempt {
    const existingAttempt = this.queuedAttempts.get(session.id);
    if (existingAttempt) return existingAttempt;
    const conversationKey = this.conversationKey(session);
    const current = this.queued.get(conversationKey) ?? [];
    if (!current.some((item) => item.session.id === session.id)) {
      current.push({ session, feedback });
      this.queued.set(conversationKey, current);
    }
    const attempt = this.attempt('queued', mechanism, { targetInstanceId });
    this.queuedAttempts.set(session.id, attempt);
    return attempt;
  }

  private scheduleDrain(conversationKey: string): void {
    if (this.draining.has(conversationKey)) return;
    const drain = this.drain(conversationKey).finally(() => {
      if (this.draining.get(conversationKey) !== drain) return;
      this.draining.delete(conversationKey);
      // A second review can be queued while the previous send is awaiting the
      // instance manager. That review has no additional state transition to
      // wake it, so continue the per-conversation drain ourselves.
      if (this.queued.has(conversationKey) && !this.deps.pauseCoordinator.isPaused()) {
        this.scheduleDrain(conversationKey);
      }
    });
    this.draining.set(conversationKey, drain);
    void drain;
  }

  private async drain(conversationKey: string): Promise<void> {
    if (this.deps.pauseCoordinator.isPaused()) return;
    const deliveries = this.queued.get(conversationKey);
    if (!deliveries?.length) return;
    this.queued.delete(conversationKey);
    for (const queued of deliveries) {
      const current = this.resolveCurrentInstance(queued.session);
      if (!current || !SETTLED_STATUSES.has(current.status)) {
        this.queued.set(conversationKey, deliveries.slice(deliveries.indexOf(queued)));
        return;
      }
      const attempt = await this.send(current.id, queued.feedback, 'direct-send');
      this.queuedAttempts.delete(queued.session.id);
      this.deps.recordRecoveredAttempt(queued.session.id, attempt);
    }
  }

  private resolveCurrentInstance(session: DocReviewSession): InstanceView | undefined {
    const origin = session.origin;
    if (!origin || origin.kind !== 'instance') {
      return this.deps.instanceManager.getInstance(session.instanceId);
    }
    const requested = this.deps.instanceManager.getInstance(origin.requestedInstanceId);
    if (requested && !REVIVABLE_STATUSES.has(requested.status)) return requested;

    const successor = this.deps.instanceManager.getAllInstances?.().find((instance) => {
      if (REVIVABLE_STATUSES.has(instance.status)) return false;
      return instance.historyThreadId === origin.historyThreadId
        || (!!origin.sessionId && (
          instance.sessionId === origin.sessionId || instance.providerSessionId === origin.sessionId
        ));
    });
    return successor ?? requested;
  }

  private conversationKey(session: DocReviewSession): string {
    const origin = session.origin;
    if (origin?.kind === 'instance') return `thread:${origin.historyThreadId}`;
    return `instance:${session.instanceId}`;
  }

  private async send(
    instanceId: string,
    feedback: string,
    mechanism: 'direct-send' | 'wake',
  ): Promise<DocReviewDeliveryAttempt> {
    try {
      await this.deps.instanceManager.sendInput(instanceId, feedback);
      return this.attempt('delivered', mechanism, { targetInstanceId: instanceId });
    } catch (error) {
      return this.failed(mechanism, error, instanceId);
    }
  }

  private failed(
    mechanism: DocReviewDeliveryAttempt['mechanism'],
    error: unknown,
    targetInstanceId?: string,
  ): DocReviewDeliveryAttempt {
    return this.attempt('failed', mechanism, {
      ...(targetInstanceId ? { targetInstanceId } : {}),
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private attempt(
    state: DocReviewDeliveryAttempt['state'],
    mechanism: DocReviewDeliveryAttempt['mechanism'],
    extra: Pick<DocReviewDeliveryAttempt, 'targetInstanceId' | 'error'> = {},
  ): DocReviewDeliveryAttempt {
    return { id: `dra_${randomUUID()}`, state, mechanism, at: Date.now(), ...extra };
  }
}
