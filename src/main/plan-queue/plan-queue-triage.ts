import { PlanQueueSpawnStoppedByUser } from './plan-queue-user-close';
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
  retireInstance(instanceId: string): void;
  now(): number;
};
interface Attempt {
  runId: string;
  attempts: number;
  provider: string;
  causes: string[];
}
interface Session {
  instanceId: string | null;
  itemIds: string[];
  provider: string;
}

export class PlanQueueTriage {
  private readonly triageByRun = new Map<string, Session>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly spawnFailures = new Map<string, { count: number; notBefore: number }>();

  constructor(private readonly host: TriageHost) {}

  maybeStart(run: PlanQueueRun, items: readonly PlanQueueItem[]): void {
    if (this.host.tracker.isShuttingDown() || run.status !== 'running' || this.triageByRun.has(run.id)) return;
    if ((this.spawnFailures.get(run.id)?.notBefore ?? 0) > this.host.now()) return;
    const undecided = items.filter((item) => item.state === 'discovered').sort((a, b) => a.createdAt - b.createdAt);
    if (!undecided.length) return;
    const firstAttempt = this.attempts.get(undecided[0].id);
    // Keep retries with the same first provider together so every second attempt is diverse.
    const batch = undecided.filter((item) => {
      const attempt = this.attempts.get(item.id);
      return firstAttempt ? attempt?.provider === firstAttempt.provider : !attempt;
    }).slice(0, TRIAGE_BATCH_SIZE);
    const session: Session = { instanceId: null, itemIds: batch.map((item) => item.id), provider: run.workerProvider ?? '' };
    this.triageByRun.set(run.id, session);
    void this.spawn(run, session, firstAttempt).catch((error: unknown) => {
      if (this.triageByRun.get(run.id) !== session) return;
      this.triageByRun.delete(run.id);
      if (this.host.tracker.isShuttingDown() || error instanceof PlanQueueSpawnStoppedByUser) return;
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
  }

  private async spawn(run: PlanQueueRun, session: Session, attempt?: Attempt): Promise<void> {
    let choice: VerifierChoice | undefined;
    if (attempt) {
      try {
        const selected = await this.host.selectVerifier({ workerProvider: attempt.provider,
          workerModel: run.workerModel, workingDirectory: run.workspaceCwd });
        if (selected.ok) choice = selected.choice;
      } catch (error) {
        logger.warn('Plan queue: retry provider unavailable', { runId: run.id, error: errorMessage(error) });
      }
    }
    if (this.triageByRun.get(run.id) !== session || this.host.tracker.isShuttingDown()) return;
    session.provider = choice?.provider ?? run.workerProvider ?? '';
    const instance = await this.host.instances.createInstance({
      displayName: 'Queue triage', isRenamed: true, parentId: this.host.liveParentId(run), workingDirectory: run.workspaceCwd,
      initialPrompt: buildTriagePrompt(run.id, session.itemIds.map((id) => this.host.getItem(id).documentPath)),
      ...(session.provider ? { provider: session.provider as InstanceProvider } : {}),
      ...(choice ? { ...(choice.modelOverride ? { modelOverride: choice.modelOverride } : {}),
        ...(choice.copilotProfileId ? { copilotProfileId: choice.copilotProfileId } : {}) }
        : run.workerModel ? { modelOverride: run.workerModel } : {}),
      yoloMode: true, metadata: { planQueueRunId: run.id, planQueueRole: 'triage' },
    });
    if (this.triageByRun.get(run.id) !== session || this.host.tracker.isShuttingDown()
      || !['running', 'paused'].includes(this.host.getRun(run.id).status)) {
      this.host.retireInstance(instance.id);
      return;
    }
    session.instanceId = instance.id;
    session.provider ||= this.host.instances.getInstance(instance.id)?.provider ?? 'unknown provider';
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
      this.host.retireInstance(instanceId);
      this.host.requestPump();
      return;
    }
    for (const id of session.itemIds) {
      if (this.host.getItem(id).state !== 'discovered') { this.attempts.delete(id); continue; }
      const attempt = this.attempts.get(id) ?? { runId, attempts: 0, provider: session.provider, causes: [] };
      attempt.attempts += 1;
      const cause = outcome.kind === 'failed' ? `its session failed: ${outcome.reason.slice(0, 1500)}`
        : outcome.kind === 'provider-limit' ? "the provider's usage limit was reached" : 'it ended without answering';
      attempt.causes.push(`${cause} (${providerLabel(session.provider)})`);
      this.attempts.set(id, attempt);
      if (attempt.attempts >= MAX_ATTEMPTS) this.park(id, attempt.causes.join(', then '));
    }
    this.host.retireInstance(instanceId);
    this.host.requestPump();
  }

  finish(runId: string): void {
    const session = this.triageByRun.get(runId);
    this.triageByRun.delete(runId);
    if (session?.instanceId) this.host.retireInstance(session.instanceId);
    this.spawnFailures.delete(runId);
    for (const [id, attempt] of this.attempts) if (attempt.runId === runId) this.attempts.delete(id);
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
