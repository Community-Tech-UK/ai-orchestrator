import { PlanQueueSpawnRoutingChanged } from './plan-queue-checker-routing';
import { PlanQueueSpawnRunPaused } from './plan-queue-run-hold';
import { PlanQueueSpawnStoppedByUser } from './plan-queue-user-close';
import { PlanQueueSpawnOutOfUsage, USAGE_RECHECK_MS } from './plan-queue-spawn';
/** Batched, bounded readiness investigation. Failed starts do not spend a document's attempts. */
import type { InstanceProvider } from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueTurnOutcome } from './plan-queue-instance-tracker';
import { buildTriagePrompt } from './plan-queue-prompts';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';
import type { VerifierChoice } from './plan-queue-verifier-select';

const logger = getLogger('PlanQueueTriage');
export const TRIAGE_BATCH_SIZE = 8;
const MAX_ATTEMPTS = 2;
const SPAWN_BACKOFF_MS = 60_000;
type TriageHost = Pick<PlanQueueFlowHost,
  'instances' | 'transition' | 'registerRole' | 'tracker' | 'requestPump' | 'getItem' | 'getRun' | 'selectVerifier' | 'consumeUserClose'> & {
  liveParentId(run: PlanQueueRun): string | undefined;
  retireInstance(instanceId: string): void | Promise<void>;
  now(): number;
};
interface Attempt {
  runId: string;
  attempts: number;
  /** Provider and model of the first attempt; a retry checks with a different one. */
  provider: string;
  model: string | null;
  causes: string[];
}
interface Session {
  instanceId: string | null;
  itemIds: string[];
  provider: string;
  model: string | null;
}

export class PlanQueueTriage {
  private readonly triageByRun = new Map<string, Session>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly spawnFailures = new Map<string, { count: number; notBefore: number }>();
  private readonly pendingSpawns = new Map<string, Promise<void>>();
  private readonly pendingStops = new Map<string, Set<string>>();
  private readonly pendingRetirements = new Map<string, Promise<void>>();

  constructor(private readonly host: TriageHost) {}

  maybeStart(run: PlanQueueRun, items: readonly PlanQueueItem[]): void {
    if (this.host.tracker.isShuttingDown() || run.status !== 'running' || this.triageByRun.has(run.id) || this.pendingSpawns.has(run.id) || this.pendingStops.has(run.id)) return;
    if ((this.spawnFailures.get(run.id)?.notBefore ?? 0) > this.host.now()) return;
    const undecided = items.filter((item) => item.state === 'discovered').sort((a, b) => a.createdAt - b.createdAt);
    if (!undecided.length) return;
    const firstAttempt = this.attempts.get(undecided[0].id);
    // Keep retries with the same first provider together so every second attempt is diverse.
    const batch = undecided.filter((item) => {
      const attempt = this.attempts.get(item.id);
      return firstAttempt ? attempt?.provider === firstAttempt.provider : !attempt;
    }).slice(0, TRIAGE_BATCH_SIZE);
    const session: Session = { instanceId: null, itemIds: batch.map((item) => item.id), provider: run.workerProvider ?? '', model: null };
    this.triageByRun.set(run.id, session);
    const spawning = this.spawn(run, session, firstAttempt).catch((error: unknown) => {
      if ((error instanceof PlanQueueSpawnRunPaused || error instanceof PlanQueueSpawnStoppedByUser) && error.instanceId) this.rememberStop(run.id, error.instanceId);
      if (this.triageByRun.get(run.id) !== session) {
        // A hold awaits this operation. Its late termination failure must reach
        // that control, while the retained ID remains available for retry.
        if (this.pendingStops.has(run.id)) {
          throw (error instanceof PlanQueueSpawnRunPaused || error instanceof PlanQueueSpawnStoppedByUser)
            && error.cause instanceof Error ? error.cause : error;
        }
        return;
      }
      this.triageByRun.delete(run.id);
      if (this.host.tracker.isShuttingDown() || error instanceof PlanQueueSpawnStoppedByUser || error instanceof PlanQueueSpawnRunPaused) return;
      if (error instanceof PlanQueueSpawnOutOfUsage) {
        // A wait, not a failed try: it never counts toward parking the documents.
        this.spawnFailures.set(run.id, { count: this.spawnFailures.get(run.id)?.count ?? 0, notBefore: this.host.now() + USAGE_RECHECK_MS });
        logger.info('Plan queue: triage waits for usage', { runId: run.id, reason: error.message });
        this.host.requestPump();
        return;
      }
      const message = errorMessage(error).slice(0, 1500);
      const count = (this.spawnFailures.get(run.id)?.count ?? 0) + 1;
      this.spawnFailures.set(run.id, { count, notBefore: this.host.now() + SPAWN_BACKOFF_MS });
      logger.warn('Plan queue: triage failed to start', { runId: run.id, error: message });
      if (count >= 3) {
        for (const id of session.itemIds) this.park(id, `its session could not start after three tries: ${message}`);
        this.spawnFailures.delete(run.id);
      }
      this.host.requestPump();
    });
    this.pendingSpawns.set(run.id, spawning);
    const settled = () => {
      if (this.pendingSpawns.get(run.id) === spawning) this.pendingSpawns.delete(run.id);
      this.host.requestPump();
    };
    // Attach both handlers immediately: holds can await rejection without an
    // unhandled background rejection when lifecycle invalidation had no caller.
    void spawning.then(settled, (error: unknown) => {
      settled();
      logger.warn('Plan queue: stopping an in-flight triage failed', { runId: run.id, error: errorMessage(error) });
    });
  }

  private async spawn(run: PlanQueueRun, session: Session, attempt?: Attempt): Promise<void> {
    for (;;) {
      try {
        await this.spawnWithCurrentRoute(this.host.getRun(run.id), session, attempt);
        return;
      } catch (error) {
        // Readiness can yield after selection. Refresh a refused stale choice
        // within this batch, without charging an attempt or failed-start backoff.
        if (!(error instanceof PlanQueueSpawnRoutingChanged)) throw error;
      }
    }
  }

  private async spawnWithCurrentRoute(run: PlanQueueRun, session: Session, attempt?: Attempt): Promise<void> {
    let choice: VerifierChoice | undefined;
    if (attempt) {
      // Selection yields to CLI detection. Recheck the route before spawning so
      // a change during that await cannot start a checker from the old list.
      for (;;) {
        run = this.host.getRun(run.id);
        if (this.triageByRun.get(run.id) !== session || this.host.tracker.isShuttingDown() || run.status !== 'running') return;
        const routingKey = JSON.stringify(run.config.routing);
        try {
          const selected = await this.host.selectVerifier({ workerProvider: attempt.provider,
            workerModel: attempt.model, workingDirectory: run.workspaceCwd,
            choices: run.config.routing?.verifiers,
            choicesOverrideLicence: run.config.routing?.checkersChosenBy === 'saved' });
          choice = selected.ok ? selected.choice : undefined;
        } catch (error) {
          logger.warn('Plan queue: retry provider unavailable', { runId: run.id, error: errorMessage(error) });
          choice = undefined;
        }
        const current = this.host.getRun(run.id);
        if (JSON.stringify(current.config.routing) === routingKey) break;
      }
    }
    if (this.triageByRun.get(run.id) !== session || this.host.tracker.isShuttingDown()) return;
    session.provider = choice?.provider ?? run.workerProvider ?? '';
    const instance = await this.host.instances.createInstance({
      displayName: 'Queue triage', isRenamed: true, parentId: this.host.liveParentId(run), workingDirectory: run.workspaceCwd,
      initialPrompt: buildTriagePrompt(run.id, session.itemIds.map((id) => this.host.getItem(id).documentPath)),
      ...(session.provider ? { provider: session.provider as InstanceProvider } : {}),
      ...(choice ? { ...(choice.modelOverride ? { modelOverride: choice.modelOverride } : {}),
        ...(choice.copilotProfileId ? { copilotAccountProfileId: choice.copilotProfileId } : {}),
        ...(choice.accountProfileIds?.length ? { allowedAccountProfileIds: [...choice.accountProfileIds] } : {}) }
        : run.workerModel ? { modelOverride: run.workerModel } : {}),
      yoloMode: true, metadata: { planQueueRunId: run.id, planQueueRole: 'triage', ...(choice ? { planQueueTriageRetry: true, planQueueRouting: JSON.stringify(run.config.routing) } : {}) },
    });
    if (this.triageByRun.get(run.id) !== session || this.host.tracker.isShuttingDown()
      || this.host.getRun(run.id).status !== 'running') {
      this.rememberStop(run.id, instance.id);
      await this.stopPending(run.id);
      return;
    }
    session.instanceId = instance.id;
    const live = this.host.instances.getInstance(instance.id);
    session.provider = live?.provider ?? (session.provider || 'unknown provider');
    session.model = live?.currentModel ?? null;
    this.spawnFailures.delete(run.id);
    this.host.registerRole(instance.id, { role: 'triage', runId: run.id });
    this.host.tracker.track(instance.id);
  }

  isTriageFor(runId: string, instanceId: string): boolean {
    return this.triageByRun.get(runId)?.instanceId === instanceId;
  }

  includesDocument(runId: string, documentPath: string): boolean {
    return this.triageByRun.get(runId)?.itemIds.some((id) => this.host.getItem(id).documentPath === documentPath) ?? false;
  }

  onOutcome(instanceId: string, runId: string, outcome: PlanQueueTurnOutcome): void {
    const session = this.triageByRun.get(runId);
    if (!session || session.instanceId !== instanceId) return;
    // Clear ownership before retiring: retirement can synchronously emit removal.
    this.triageByRun.delete(runId);
    if (this.host.consumeUserClose?.(instanceId)) {
      this.retire(runId, instanceId);
      this.host.requestPump();
      return;
    }
    for (const id of session.itemIds) {
      if (this.host.getItem(id).state !== 'discovered') { this.attempts.delete(id); continue; }
      const attempt = this.attempts.get(id) ?? { runId, attempts: 0, provider: session.provider, model: session.model, causes: [] };
      attempt.attempts += 1;
      const cause = outcome.kind === 'failed' ? `its session failed: ${outcome.reason.slice(0, 1500)}`
        : outcome.kind === 'provider-limit' ? "the provider's usage limit was reached" : 'it ended without answering';
      attempt.causes.push(`${cause} (${providerLabel(session.provider)})`);
      this.attempts.set(id, attempt);
      if (attempt.attempts >= MAX_ATTEMPTS) this.park(id, attempt.causes.join(', then '));
    }
    this.retire(runId, instanceId);
    this.host.requestPump();
  }

  /** Invalidate ownership first, so late spawns/outcomes cannot spend an attempt. */
  async pause(runId: string): Promise<void> {
    const session = this.triageByRun.get(runId);
    this.triageByRun.delete(runId);
    this.spawnFailures.delete(runId);
    if (session?.instanceId) this.rememberStop(runId, session.instanceId);
    await this.pendingSpawns.get(runId);
    await this.pendingRetirements.get(runId);
    await this.stopPending(runId);
  }

  isStopping(runId: string): boolean { return this.pendingStops.has(runId); }

  /** Includes spawn and teardown gaps where no live instance has been assigned yet. */
  hasActiveWork(runId: string): boolean {
    return this.triageByRun.has(runId) || this.pendingSpawns.has(runId)
      || this.pendingStops.has(runId) || this.pendingRetirements.has(runId);
  }

  private rememberStop(runId: string, instanceId: string): void {
    const pending = this.pendingStops.get(runId) ?? new Set<string>();
    pending.add(instanceId);
    this.pendingStops.set(runId, pending);
  }

  private async stopPending(runId: string): Promise<void> {
    const pending = this.pendingStops.get(runId);
    if (!pending) return;
    for (const id of pending) {
      await this.host.retireInstance(id);
      pending.delete(id);
    }
    if (this.pendingStops.get(runId) === pending && pending.size === 0) this.pendingStops.delete(runId);
  }

  /** Start cleanup without blocking the pump; terminal status waits for all ownership to clear. */
  finish(runId: string): boolean {
    const session = this.triageByRun.get(runId);
    this.triageByRun.delete(runId);
    if (session?.instanceId) this.retire(runId, session.instanceId);
    if (this.pendingSpawns.has(runId) || this.pendingStops.has(runId)) return false;
    this.spawnFailures.delete(runId);
    for (const [id, attempt] of this.attempts) if (attempt.runId === runId) this.attempts.delete(id);
    return true;
  }

  private retire(runId: string, instanceId: string): void {
    // Outcome cleanup remains owned after the active batch has been invalidated.
    this.rememberStop(runId, instanceId);
    const retiring = this.stopPending(runId);
    this.pendingRetirements.set(runId, retiring);
    const settled = () => {
      if (this.pendingRetirements.get(runId) === retiring) this.pendingRetirements.delete(runId);
      this.host.requestPump();
    };
    void retiring.then(settled, (error: unknown) => {
      settled();
      logger.warn('Plan queue: stopping triage failed', { instanceId, error: errorMessage(error) });
    });
  }

  private park(id: string, cause: string): void {
    const item = this.host.getItem(id);
    if (item.state !== 'discovered' || !['running', 'paused'].includes(this.host.getRun(item.runId).status)) return;
    const reason = cause.replace(/\.$/, '');
    this.host.transition(item, 'parked', { parkReason: 'triage-failed', question: null,
      detail: `Harness couldn't check whether this document is ready to work on: ${reason}. Resume starts work on it without the check.` });
    this.attempts.delete(id);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function providerLabel(provider: string): string {
  return provider ? provider[0].toUpperCase() + provider.slice(1) : 'Unknown provider';
}
