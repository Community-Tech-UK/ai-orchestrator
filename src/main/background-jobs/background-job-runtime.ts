import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { LaneGateway } from './lane-gateway';
import type {
  BackgroundJobEnqueueResult,
  BackgroundJobLane,
  BackgroundJobPriority,
  BackgroundJobRecord,
  BackgroundJobSnapshot,
  BackgroundJobSubmission,
  LaneDegradedEvent,
  LaneHeartbeatEvent,
  LaneProgressEvent,
} from './types';

interface InternalJob {
  record: BackgroundJobRecord;
  payload: unknown;
  idempotent: boolean;
  maxAttempts: number;
  attempts: number;
  activeRunId: number;
  cancellationRequested: boolean;
  result?: unknown;
  waiters: Array<{
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>;
}

export interface BackgroundJobRuntimeOptions {
  lanes?: Partial<Record<BackgroundJobLane, LaneGateway>>;
  maxPendingPerLane?: Partial<Record<BackgroundJobLane, number>>;
  maxInFlightPerLane?: Partial<Record<BackgroundJobLane, number>>;
  laneHeartbeatTimeoutMs?: Partial<Record<BackgroundJobLane, number>>;
  now?: () => number;
}

const DEFAULT_MAX_PENDING = 100;
const DEFAULT_MAX_IN_FLIGHT = 1;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;

const PRIORITY_RANK: Record<BackgroundJobPriority, number> = {
  'user-blocking': 0,
  normal: 1,
  background: 2,
};

export class BackgroundJobRuntime extends EventEmitter {
  private readonly lanes = new Map<BackgroundJobLane, LaneGateway>();
  private readonly jobs = new Map<string, InternalJob>();
  private readonly queues = new Map<BackgroundJobLane, string[]>();
  private readonly runningByLane = new Map<BackgroundJobLane, Set<string>>();
  private readonly scheduledDrains = new Set<BackgroundJobLane>();
  private readonly heartbeatTimers = new Map<BackgroundJobLane, NodeJS.Timeout>();
  private readonly maxPendingPerLane: Partial<Record<BackgroundJobLane, number>>;
  private readonly maxInFlightPerLane: Partial<Record<BackgroundJobLane, number>>;
  private readonly laneHeartbeatTimeoutMs: Partial<Record<BackgroundJobLane, number>>;
  private readonly now: () => number;
  private stopped = false;

  constructor(options: BackgroundJobRuntimeOptions = {}) {
    super();
    this.maxPendingPerLane = options.maxPendingPerLane ?? {};
    this.maxInFlightPerLane = options.maxInFlightPerLane ?? {};
    this.laneHeartbeatTimeoutMs = options.laneHeartbeatTimeoutMs ?? {};
    this.now = options.now ?? (() => Date.now());

    for (const lane of Object.values(options.lanes ?? {})) {
      if (lane) this.registerLane(lane);
    }
  }

  registerLane(gateway: LaneGateway): void {
    this.lanes.set(gateway.lane, gateway);
    gateway.on('progress', (event) => this.handleProgress(event));
    gateway.on('heartbeat', (event) => this.handleHeartbeat(event));
    gateway.on('degraded', (event) => this.handleDegraded(event));
  }

  enqueue(submission: BackgroundJobSubmission): BackgroundJobEnqueueResult {
    if (this.stopped) {
      throw new Error('Background job runtime has stopped');
    }

    const queue = this.queueFor(submission.lane);
    const existingId = this.findCoalescedQueuedJob(submission);
    if (existingId) {
      return { jobId: existingId, coalesced: true };
    }

    const pendingLimit = this.maxPendingPerLane[submission.lane] ?? DEFAULT_MAX_PENDING;
    if (queue.length >= pendingLimit) {
      throw new Error(`Background job pending limit exceeded for lane ${submission.lane}`);
    }

    const id = `bg-job-${randomUUID()}`;
    const record: BackgroundJobRecord = {
      id,
      lane: submission.lane,
      type: submission.type,
      priority: submission.priority,
      coalesceKey: submission.coalesceKey,
      createdAt: this.now(),
      status: 'queued',
    };
    this.jobs.set(id, {
      record,
      payload: submission.payload,
      idempotent: submission.idempotent === true,
      maxAttempts: this.normalizeMaxAttempts(submission),
      attempts: 0,
      activeRunId: 0,
      cancellationRequested: false,
      waiters: [],
    });
    queue.push(id);
    this.scheduleDrain(submission.lane);
    return { jobId: id, coalesced: false };
  }

  enqueueAndWait(submission: BackgroundJobSubmission): Promise<unknown> {
    const { jobId } = this.enqueue(submission);
    const job = this.jobs.get(jobId);
    if (!job) {
      return Promise.reject(new Error(`Background job not found: ${jobId}`));
    }
    if (job.record.status === 'succeeded') {
      return Promise.resolve(job.result);
    }
    if (this.isTerminalFailure(job.record.status)) {
      return Promise.reject(new Error(job.record.errorMessage ?? `Background job ${jobId} ${job.record.status}`));
    }
    return new Promise((resolve, reject) => {
      job.waiters.push({ resolve, reject });
    });
  }

  getJob(jobId: string): BackgroundJobRecord | undefined {
    const job = this.jobs.get(jobId);
    return job ? { ...job.record, progress: job.record.progress ? { ...job.record.progress } : undefined } : undefined;
  }

  snapshot(): BackgroundJobSnapshot {
    const queued: BackgroundJobRecord[] = [];
    const running: BackgroundJobRecord[] = [];
    const terminal: BackgroundJobRecord[] = [];

    for (const job of this.jobs.values()) {
      const copy = { ...job.record, progress: job.record.progress ? { ...job.record.progress } : undefined };
      if (copy.status === 'queued') queued.push(copy);
      else if (copy.status === 'running') running.push(copy);
      else terminal.push(copy);
    }

    return { queued, running, terminal };
  }

  async cancel(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || this.isTerminal(job.record.status)) {
      return false;
    }

    if (job.record.status === 'queued') {
      this.removeQueuedJob(job.record.lane, jobId);
      this.completeJob(job, 'cancelled');
      return true;
    }

    const lane = this.lanes.get(job.record.lane);
    if (lane) {
      await lane.cancelJob(jobId);
    }
    job.cancellationRequested = true;
    this.emit('status', { ...job.record });
    return true;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    for (const timer of this.heartbeatTimers.values()) {
      clearTimeout(timer);
    }
    this.heartbeatTimers.clear();
    this.scheduledDrains.clear();

    const reason = 'Background job runtime stopped';
    for (const queue of this.queues.values()) {
      for (const jobId of queue.splice(0)) {
        const job = this.jobs.get(jobId);
        if (job?.record.status === 'queued') {
          this.completeJob(job, 'cancelled', reason);
        }
      }
    }

    for (const running of this.runningByLane.values()) {
      for (const jobId of running) {
        const job = this.jobs.get(jobId);
        if (job?.record.status === 'running') {
          job.activeRunId++;
          job.cancellationRequested = true;
          this.completeJob(job, 'cancelled', reason);
        }
      }
      running.clear();
    }
    this.runningByLane.clear();

    await Promise.all(Array.from(this.lanes.values()).map((lane) => lane.stop()));
  }

  private scheduleDrain(lane: BackgroundJobLane): void {
    if (this.stopped) return;
    if (this.scheduledDrains.has(lane)) return;
    this.scheduledDrains.add(lane);
    queueMicrotask(() => {
      this.scheduledDrains.delete(lane);
      if (this.stopped) return;
      this.drainLane(lane);
    });
  }

  private drainLane(lane: BackgroundJobLane): void {
    if (this.stopped) return;
    const gateway = this.lanes.get(lane);
    if (!gateway) return;

    const maxInFlight = this.maxInFlightPerLane[lane] ?? DEFAULT_MAX_IN_FLIGHT;
    while (this.runningCount(lane) < maxInFlight) {
      const nextJobId = this.shiftNextJob(lane);
      if (!nextJobId) return;
      const job = this.jobs.get(nextJobId);
      if (!job || job.record.status !== 'queued') {
        continue;
      }
      this.startJob(lane, gateway, nextJobId, job);
    }
  }

  private startJob(
    lane: BackgroundJobLane,
    gateway: LaneGateway,
    nextJobId: string,
    job: InternalJob,
  ): void {
    this.runningSetFor(lane).add(nextJobId);
    job.activeRunId++;
    job.attempts++;
    job.cancellationRequested = false;
    job.record.status = 'running';
    job.record.startedAt = this.now();
    job.record.completedAt = undefined;
    job.record.errorMessage = undefined;
    this.armHeartbeatTimeout(lane);
    this.emit('status', { ...job.record });

    void this.executeJob(lane, gateway, nextJobId, job, job.activeRunId);
  }

  private async executeJob(
    lane: BackgroundJobLane,
    gateway: LaneGateway,
    nextJobId: string,
    job: InternalJob,
    runId: number,
  ): Promise<void> {
    try {
      await gateway.start();
      const result = await gateway.runJob({ ...job.record }, job.payload);
      if (this.isCurrentRunningAttempt(job, runId)) {
        if (job.cancellationRequested) {
          this.completeJob(job, 'cancelled');
          return;
        }
        job.result = result;
        this.completeJob(job, 'succeeded');
      }
    } catch (error) {
      if (this.isCurrentRunningAttempt(job, runId)) {
        if (job.cancellationRequested || this.isCancellationError(error)) {
          this.completeJob(job, 'cancelled');
          return;
        }
        this.completeJob(
          job,
          'failed',
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      if (job.activeRunId === runId) {
        this.runningByLane.get(lane)?.delete(nextJobId);
        if (this.runningCount(lane) === 0) {
          this.clearHeartbeatTimeout(lane);
        }
        this.scheduleDrain(lane);
      }
    }
  }

  private queueFor(lane: BackgroundJobLane): string[] {
    let queue = this.queues.get(lane);
    if (!queue) {
      queue = [];
      this.queues.set(lane, queue);
    }
    return queue;
  }

  private runningSetFor(lane: BackgroundJobLane): Set<string> {
    let running = this.runningByLane.get(lane);
    if (!running) {
      running = new Set<string>();
      this.runningByLane.set(lane, running);
    }
    return running;
  }

  private runningCount(lane: BackgroundJobLane): number {
    return this.runningByLane.get(lane)?.size ?? 0;
  }

  private findCoalescedQueuedJob(submission: BackgroundJobSubmission): string | null {
    if (!submission.coalesceKey) return null;
    const queue = this.queueFor(submission.lane);
    for (const jobId of queue) {
      const job = this.jobs.get(jobId);
      if (
        job?.record.status === 'queued'
        && job.record.lane === submission.lane
        && job.record.type === submission.type
        && job.record.coalesceKey === submission.coalesceKey
      ) {
        return jobId;
      }
    }
    return null;
  }

  private shiftNextJob(lane: BackgroundJobLane): string | undefined {
    const queue = this.queueFor(lane);
    if (queue.length === 0) return undefined;
    let bestIndex = 0;
    let bestRank = Number.POSITIVE_INFINITY;
    for (let i = 0; i < queue.length; i++) {
      const job = this.jobs.get(queue[i]);
      if (!job) continue;
      const rank = PRIORITY_RANK[job.record.priority];
      if (rank < bestRank) {
        bestRank = rank;
        bestIndex = i;
      }
    }
    return queue.splice(bestIndex, 1)[0];
  }

  private removeQueuedJob(lane: BackgroundJobLane, jobId: string): void {
    const queue = this.queueFor(lane);
    const index = queue.indexOf(jobId);
    if (index !== -1) {
      queue.splice(index, 1);
    }
  }

  private handleProgress(event: LaneProgressEvent): void {
    const job = this.jobs.get(event.jobId);
    if (!job || job.record.status !== 'running') return;
    job.record.progress = { ...event.progress };
    this.emit('progress', {
      job: { ...job.record },
      progress: { ...event.progress },
    });
  }

  private handleHeartbeat(event: LaneHeartbeatEvent): void {
    this.emit('heartbeat', event);
    this.armHeartbeatTimeout(event.lane);
  }

  private handleDegraded(event: LaneDegradedEvent): void {
    this.emit('degraded', event);
  }

  private armHeartbeatTimeout(lane: BackgroundJobLane): void {
    this.clearHeartbeatTimeout(lane);
    const timeoutMs = this.laneHeartbeatTimeoutMs[lane] ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      const runningJobIds = [...(this.runningByLane.get(lane) ?? [])];
      if (runningJobIds.length === 0) return;
      const reason = `Lane ${lane} heartbeat timed out`;
      for (const runningJobId of runningJobIds) {
        const job = this.jobs.get(runningJobId);
        if (!job || job.record.status !== 'running') continue;
        if (this.shouldRetryStaleJob(job)) {
          this.requeueStaleJob(job, reason);
        } else {
          this.completeJob(job, 'stale', reason);
        }
      }
      this.runningByLane.delete(lane);
      this.clearHeartbeatTimeout(lane);
    this.emit('degraded', { lane, reason });
    const gateway = this.lanes.get(lane);
    void gateway?.stop().finally(() => this.scheduleDrain(lane));
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.heartbeatTimers.set(lane, timer);
  }

  private clearHeartbeatTimeout(lane: BackgroundJobLane): void {
    const timer = this.heartbeatTimers.get(lane);
    if (timer) clearTimeout(timer);
    this.heartbeatTimers.delete(lane);
  }

  private completeJob(
    job: InternalJob,
    status: BackgroundJobRecord['status'],
    errorMessage?: string,
  ): void {
    job.record.status = status;
    job.record.completedAt = this.now();
    if (errorMessage) {
      job.record.errorMessage = errorMessage;
    } else {
      job.record.errorMessage = undefined;
    }
    this.emit('status', { ...job.record });

    for (const waiter of job.waiters.splice(0)) {
      if (status === 'succeeded') {
        waiter.resolve(job.result);
      } else {
        waiter.reject(new Error(job.record.errorMessage ?? `Background job ${job.record.id} ${status}`));
      }
    }
  }

  private isTerminal(status: BackgroundJobRecord['status']): boolean {
    return status === 'succeeded'
      || status === 'failed'
      || status === 'cancelled'
      || status === 'stale';
  }

  private isTerminalFailure(status: BackgroundJobRecord['status']): boolean {
    return status === 'failed' || status === 'cancelled' || status === 'stale';
  }

  private normalizeMaxAttempts(submission: BackgroundJobSubmission): number {
    if (typeof submission.maxAttempts === 'number' && Number.isFinite(submission.maxAttempts)) {
      return Math.max(1, Math.floor(submission.maxAttempts));
    }
    return submission.idempotent === true ? 2 : 1;
  }

  private shouldRetryStaleJob(job: InternalJob): boolean {
    return job.idempotent
      && !job.cancellationRequested
      && job.attempts < job.maxAttempts;
  }

  private requeueStaleJob(job: InternalJob, reason: string): void {
    job.record.status = 'queued';
    job.record.startedAt = undefined;
    job.record.completedAt = undefined;
    job.record.errorMessage = reason;
    job.record.progress = undefined;
    this.queueFor(job.record.lane).unshift(job.record.id);
    this.emit('status', { ...job.record });
  }

  private isCurrentRunningAttempt(job: InternalJob, runId: number): boolean {
    return job.activeRunId === runId && job.record.status === 'running';
  }

  private isCancellationError(error: unknown): boolean {
    return error instanceof Error && /cancelled|canceled/i.test(error.message);
  }
}
