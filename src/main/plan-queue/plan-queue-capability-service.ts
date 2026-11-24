import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PlanQueueAccountRules, PlanQueueCapabilityGap, PlanQueueReportCapabilityGapArgs,
  PlanQueueReportCapabilityProbeArgs, PlanQueueReportCapabilityCheckArgs } from '@contracts/schemas/plan-queue';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { FAILED_RERUN, heldForOwner, landedInOwnerRun, type CapabilityRepair, type CapabilityOrigin } from './plan-queue-capability-store';
import { launchCapabilityRun } from './plan-queue-capability-launch';
import { ensureCapabilityPlan, validateCapabilityProbe } from './plan-queue-capability-plan';
import { gitExec } from '../workspace/git/git-exec';
import type { PlanQueueItem } from './plan-queue.types';
import { redactValue } from '../diagnostics/redaction';
import { repositoryRoot } from './plan-queue-git';
import { preserveRecoveryReceipts } from './plan-queue-store';
import { hasHarnessRuntimeLauncher } from './plan-queue-capability-prompts';

export interface CapabilityHooks {
  currentTriage(runId: string, instanceId: string, sourceRef: string): boolean;
  forgetTriage(runId: string, itemId: string): void;
  accountRules(): PlanQueueAccountRules;
  excludedProviders(): string[];
  sourceSettled(itemId: string): boolean;
  controlRun(runId: string, action: 'pause' | 'resume' | 'cancel'): Promise<void>;
  retryOrigin(itemId: string): Promise<boolean>;
}
const RELEASE = 'Resume the original job to recheck it.';
const technical = (gap: PlanQueueCapabilityGap): boolean => gap.classification === 'capability' || gap.classification === 'setup';
const activeOrigin = (origin: CapabilityOrigin): boolean => origin.state !== 'withdrawn' && origin.state !== 'passed';

/** Durable orchestration only. Existing queue scheduling, ownership, worktrees, gates and landing do all execution. */
export class PlanQueueCapabilityService {
  constructor(private readonly host: PlanQueueFlowHost, private readonly hooks: CapabilityHooks, private readonly now: () => number = Date.now,
    private readonly launch: typeof launchCapabilityRun = launchCapabilityRun) {}

  private authenticate(caller: string, args: Pick<PlanQueueReportCapabilityGapArgs, 'item_id' | 'run_id' | 'document_path'>): PlanQueueItem {
    const item = args.item_id ? this.host.getItem(args.item_id)
      : this.host.store.listItems(args.run_id!).find(item => item.sourceRef === args.document_path);
    if (!item) throw new Error('The capability report does not name an item in this run.');
    const role = this.host.roleOf(caller);
    const current = role?.runId === item.runId && ((role.role === 'worker' && role.itemId === item.id
      && item.workerInstanceId === caller && (item.state === 'working' || item.state === 'fixing'))
      || (role.role === 'verifier' && role.itemId === item.id && item.verifierInstanceId === caller && item.state === 'verifying')
      || (role.role === 'triage' && item.state === 'discovered' && this.hooks.currentTriage(item.runId, caller, item.sourceRef)));
    if (!current || this.host.getRun(item.runId).status !== 'running') throw new Error('Only this item’s currently assigned worker, checker or triage agent in a running run may report a missing capability.');
    return item;
  }

  async reportGap(caller: string, args: PlanQueueReportCapabilityGapArgs) {
    let item = this.authenticate(caller, args);
    let run = this.host.getRun(item.runId);
    const repository = await fs.realpath(run.workspaceCwd);
    const gap = { ...args.gap };
    // The named repository reaches the repair plan and the owner's message, so only a real repository root is kept.
    if (gap.repairRepository) gap.repairRepository = await repositoryRoot(gap.repairRepository).then(root => fs.realpath(root), () => {
      throw new Error('repairRepository must be the path of an existing Git repository on the coordinating computer.');
    });
    // Recheck caller assignment after filesystem I/O: a cancelled/replaced session cannot report late.
    item = this.authenticate(caller, args); run = this.host.getRun(item.runId);
    if (run.status !== 'running') throw new Error('A paused or cancelled run cannot report new capability work.');
    if (args.gap.attempts.some(attempt => attempt.observedAt > this.now() || attempt.observedAt < this.now() - 7 * 86_400_000)) throw new Error('Capability observations must be from the last seven days, with no future timestamps.');
    if (Buffer.byteLength(JSON.stringify(args.gap)) > 24_000) throw new Error('The capability evidence exceeds 24 KB; give bounded, redacted observations.');
    if (JSON.stringify(redactValue(args.gap, { homeDir: '' })) !== JSON.stringify(args.gap)) throw new Error('Capability evidence contains sensitive material; submit redacted observations.');
    const ownId = run.config.capabilityRepairId ?? this.host.store.capabilities.forRepairItem(item.id)?.id;
    if (ownId) {
      const own = this.host.store.capabilities.get(ownId)!;
      this.host.store.capabilities.save({ ...own, state: 'waiting', detail: `This repair found a further prerequisite: ${args.gap.requiredAction}. No nested repair was started.` });
      return { repairId: own.id, state: 'waiting', message: 'Record the prerequisite and stop. The owner must resolve it; repairs never spawn repairs.' };
    }
    const repair = this.host.store.capabilities.attach({ repository, sourceRunId: run.id, itemId: item.id, gap,
      config: { ...run.config, capabilityRepairExcludedProviders: [...new Set([...(run.config.startingProviderExclusions ?? []), ...this.hooks.excludedProviders()])] },
      accountRules: this.hooks.accountRules(), planDirectory: 'docs/plans',
      reportedBy: { instanceId: caller, role: this.host.roleOf(caller)!.role, round: item.round, at: this.now() } });
    // Any check of this item being rerun on this repair counts, however the new report words it.
    const retried = this.host.store.capabilities.origins(repair.id).filter(origin => origin.itemId === item.id && origin.state === 'retrying');
    if (retried.length && technical(gap)) {
      for (const origin of retried) this.host.store.capabilities.setOriginState(origin, 'waiting');
      const detail = `${FAILED_RERUN} Its owner must investigate the new evidence and arrange a corrective plan; the landed repair is not retried blindly. ${RELEASE}`;
      this.host.store.capabilities.save({ ...repair, state: 'waiting', detail, heldForOwner: true });
      this.host.notifyParent(run, `${detail} Existing repair plan: ${repair.planPath}`, undefined, true);
    }
    if (technical(args.gap) && repair.state === 'investigating') {
      await ensureCapabilityPlan(repair);
      const current = this.host.store.capabilities.get(repair.id)!;
      if (current.state === 'investigating') this.host.store.capabilities.save({ ...current, state: 'planned', detail: 'A bounded repair plan is ready for the authorised repository owner.' });
    }
    item = this.authenticate(caller, args); run = this.host.getRun(item.runId);
    if (run.status !== 'running') throw new Error('The run stopped while its repair plan was being written. The evidence remains recorded.');
    if (technical(args.gap) && item.state === 'discovered') {
      this.hooks.forgetTriage(run.id, item.id);
      this.host.transition(item, 'parked', { parkReason: 'needs-setup', question: null,
        detail: `Waiting for a repair: ${args.gap.requiredAction}. Its plan is ${repair.planPath}` });
    }
    this.host.requestPump();
    if (!technical(args.gap)) this.host.store.capabilities.save({ ...this.host.store.capabilities.get(repair.id)!, state: 'waiting', detail: `A genuine human boundary remains: ${args.gap.requiredAction}. No new permission was inferred.` });
    return { repairId: repair.id, state: this.host.store.capabilities.get(repair.id)!.state, message: technical(args.gap)
      ? 'The missing control is recorded durably. Keep the original check open and end your turn; its work is saved before the repair runs.'
      : 'The missing authority or human fact is recorded. Existing approval controls still apply; no technical repair grants permission.' };
  }

  /** Called at the turn boundary, not from inside a worker’s tool request. */
  waitingForRepair(itemId: string): boolean {
    if (this.host.store.capabilities.forRepairItem(itemId)?.state === 'waiting') return true;
    const repairs = this.host.store.capabilities.forOrigin(itemId);
    return repairs.some(repair => technical(repair.gap) && this.host.store.capabilities.origins(repair.id)
      .some(origin => origin.itemId === itemId && origin.state === 'waiting'));
  }

  assertCanPass(item: PlanQueueItem): void {
    if (this.waitingForRepair(item.id)) throw new Error('This item still has an unverified capability gap. Keep its acceptance check open.');
    const pendingChecks = this.host.store.capabilities.forOrigin(item.id).flatMap(repair => this.host.store.capabilities.origins(repair.id))
      .filter(origin => origin.itemId === item.id && origin.state === 'retrying');
    if (pendingChecks.some(origin => !item.checkpointCommit || origin.verification?.checkpoint !== item.checkpointCommit)) {
      throw new Error('Report independent evidence for every retried original check at this checkpoint before PASS.');
    }
    const repair = this.host.store.capabilities.forRepairItem(item.id);
    // Only a repository with Harness's launcher can produce a probe; elsewhere the review alone decides, like any other job.
    if (repair && hasHarnessRuntimeLauncher(this.host.getRun(item.runId).workspaceCwd)
      && (!repair.probeReceipt || repair.probeCheckedCommit !== item.checkpointCommit)) throw new Error('Report a fresh independent runtime probe for this repair checkpoint before PASS.');
  }

  summaries(runId: string) {
    return this.host.store.listItems(runId).flatMap(item => this.host.store.capabilities.forOrigin(item.id).map(repair => ({
      itemId: item.id, repairId: repair.id, state: repair.state, planPath: repair.planPath, repairRunId: repair.repairRunId,
      repairRunStatus: repair.repairRunId ? this.host.store.getRun(repair.repairRunId)?.status ?? null : null,
      repairItemState: repair.repairItemId ? this.host.store.getItem(repair.repairItemId)?.state ?? null : null,
      detail: repair.detail, checks: this.host.store.capabilities.origins(repair.id).filter(origin => origin.itemId === item.id)
        .map(origin => ({ check: origin.check, state: origin.state })),
    })));
  }

  async reportProbe(caller: string, args: PlanQueueReportCapabilityProbeArgs) {
    const item = this.authenticate(caller, args);
    if (item.state !== 'verifying' || item.verifierInstanceId !== caller || !item.checkpointCommit || !item.worktreePath) throw new Error('Only the independent checker of the current checkpoint may attest a runtime probe.');
    const repair = this.host.store.capabilities.forRepairItem(item.id);
    if (!repair) throw new Error('This item does not own a capability repair.');
    const tree = await gitExec(['rev-parse', `${item.checkpointCommit}^{tree}`], item.worktreePath);
    const receipt = await validateCapabilityProbe(item.worktreePath, args.probe, tree.trim(), item.updatedAt, this.now());
    const current = this.authenticate(caller, args);
    if (current.checkpointCommit !== item.checkpointCommit) throw new Error('The reviewed checkpoint changed during the probe report.');
    const latest = this.host.store.capabilities.get(repair.id)!;
    if (latest.state === 'cancelled') throw new Error('This capability repair was cancelled while its probe was read.');
    this.host.store.capabilities.save({ ...latest, probe: args.probe, probeCheckedCommit: item.checkpointCommit, probeReceipt: receipt });
    return { accepted: true, message: 'Runtime evidence retained. An independent PASS and landing are still required.' };
  }

  reportCheck(caller: string, args: PlanQueueReportCapabilityCheckArgs) {
    const item = this.authenticate(caller, args);
    if (item.state !== 'verifying' || item.verifierInstanceId !== caller || !item.checkpointCommit) throw new Error('Only the current independent checker may report the original check passed.');
    const origin = this.host.store.capabilities.origins(args.repair_id).find(origin => origin.itemId === item.id && origin.check === args.check);
    if (!origin || origin.state !== 'retrying') throw new Error('This check is not awaiting verification after a capability repair.');
    if (redactValue(args.evidence, { homeDir: '' }) !== args.evidence) throw new Error('Original-check evidence must be redacted before it is retained.');
    this.host.store.capabilities.recordCheck(origin, { checkpoint: item.checkpointCommit, evidence: args.evidence });
    return { accepted: true, message: 'This check’s evidence is retained; it resolves after this checkpoint receives PASS and lands. Other checks remain open.' };
  }

  async reconcile(): Promise<void> {
    const store = this.host.store.capabilities, repairs = store.list();
    for (const repair of repairs) {
      try { await this.reconcileOne(await this.adoptOwnerRun(repair)); }
      catch (error) {
        const current = store.get(repair.id)!;
        if (current.state === 'cancelled' || current.state === 'resolved') continue;
        // A landed repair that keeps failing here would otherwise be retried on every pass; it waits for its owner.
        const landed = current.repairItemId ? this.host.store.getItem(current.repairItemId)?.state === 'landed' : false;
        const message = redactValue(error instanceof Error ? error.message : String(error), { homeDir: '' });
        store.save({ ...current, state: 'waiting', detail: landed ? `${message} ${RELEASE}` : message, ...(landed ? { heldForOwner: true } : {}) });
        if (landed && !current.heldForOwner) this.host.notifyParent(this.host.getRun(current.sourceRunId), `Harness could not move on after a repair landed: ${message} ${RELEASE} Repair plan: ${current.planPath}`, undefined, true);
      }
    }
    // The repairs each original job still waits for after this pass, oldest first (the order `list()` returns).
    const waitingFor = new Map<string, CapabilityRepair[]>();
    for (const { id } of repairs) {
      for (const itemId of new Set(store.origins(id).filter(origin => origin.state === 'waiting').map(origin => origin.itemId))) {
        waitingFor.set(itemId, [...waitingFor.get(itemId) ?? [], store.get(id)!]);
      }
    }
    for (const [itemId, waiting] of waitingFor) this.publishWaitingStatus(itemId, waiting);
  }

  /**
   * A repair for another repository is never started from here. Its owner queues the copied plan in their own run
   * (`capability-<repair id>_plan.md`, in the repository the gap names). That item becomes the repair's item, so its
   * runtime probe is kept, the original check reruns after it lands, and it cannot report a further repair. The run
   * itself stays the owner's: it is never paused or cancelled for the repair. Where the repository has Harness's
   * launcher, only an item whose independent PASS is still ahead is linked: a PASS given before the link never had to
   * carry the runtime probe, so an item that passed, is landing or landed, or sits in a finished run cannot stand in
   * for the repair. Elsewhere no probe is ever asked for, so an item that already landed (in any run) is linked too and
   * the original check reruns on the code it landed.
   */
  private async adoptOwnerRun(repair: CapabilityRepair): Promise<CapabilityRepair> {
    const target = repair.gap.repairRepository;
    if (repair.repairRunId || !target || target === repair.repository) return repair;
    const wanted = `capability-${repair.id}_plan.md`;
    const landedCounts = !hasHarnessRuntimeLauncher(target);
    for (const run of this.host.store.listRuns()) {
      if (run.config.capabilityRepairId) continue;
      const root = await fs.realpath(run.workspaceCwd).catch(() => null);
      if (root !== target && !root?.startsWith(target + path.sep)) continue;
      const open = ['running', 'paused'].includes(run.status);
      const item = this.host.store.listItems(run.id).find(candidate => path.basename(candidate.sourceRef) === wanted
        && !candidate.discardedAt && !this.host.store.capabilities.forRepairItem(candidate.id)
        && (candidate.state === 'landed' ? landedCounts && candidate.verdict?.verdict === 'PASS'
          : open && !['skipped', 'landing'].includes(candidate.state) && candidate.verdict?.verdict !== 'PASS'));
      if (!item) continue;
      const latest = this.host.store.capabilities.get(repair.id)!;
      if (latest.repairRunId) return latest;
      const linked = { ...latest, repairRunId: run.id, repairItemId: item.id, ownerRun: true,
        state: latest.state === 'waiting' || latest.state === 'planned' ? 'running' as const : latest.state,
        detail: 'The repository owner is implementing this repair in their own queue run.' };
      this.host.store.capabilities.save(linked);
      return linked;
    }
    return repair;
  }

  /**
   * One status per parked job, written only when it changes. A job waiting for two repairs once took each repair's
   * wording in turn, so every queue pass rewrote it twice and pushed the whole run to the window each time.
   */
  private publishWaitingStatus(itemId: string, repairs: readonly CapabilityRepair[]): void {
    const original = this.host.getItem(itemId);
    if (original.state !== 'parked' || original.parkReason !== 'needs-setup') return;
    const detail = repairs.length === 1 ? `${this.repairStatus(repairs[0]!)} Original check still open. Repair plan: ${repairs[0]!.planPath}`
      : ['Original check still open.', ...repairs.map(repair => `${this.repairStatus(repair)} Repair plan: ${repair.planPath}`)].join('\n');
    // Compare what the store would keep: it carries recovery receipts over from the saved detail.
    if (preserveRecoveryReceipts(original.detail, detail) !== original.detail) this.host.save({ ...original, detail });
  }

  private repairStatus(repair: CapabilityRepair): string {
    const run = repair.repairRunId ? this.host.store.getRun(repair.repairRunId) : undefined;
    const item = repair.repairItemId ? this.host.store.getItem(repair.repairItemId) : undefined;
    return repair.state === 'cancelled' ? 'The repair was cancelled.' : run?.status === 'paused' ? 'The repair is paused.'
      : item?.state === 'working' || item?.state === 'fixing' ? 'The repair is being implemented.'
      : item?.state === 'verifying' ? 'The repair is under independent review.'
      : item?.state === 'queued' || item?.state === 'preparing' || item?.state === 'awaiting-slot' ? 'The repair is queued.'
      : repair.detail;
  }

  private handoff(repair: CapabilityRepair, detail: string): void {
    this.host.store.capabilities.save({ ...repair, state: 'waiting', detail });
    if (repair.state === 'waiting' && repair.detail === detail) return;
    this.host.notifyParent(this.host.getRun(repair.sourceRunId), `${detail} Linked plan: ${repair.planPath}. `
      + 'For repairs already authorised in this source repository, use plan_queue_authorize_capability_repairs with the source run_id and repository. '
      + 'Other repositories need their own owner handoff. Recheck old unanswered readiness questions with recheck-readiness; do not fabricate an answer.', undefined, true);
  }

  private async reconcileOne(repair: CapabilityRepair): Promise<void> {
    const store = this.host.store.capabilities;
    for (const origin of store.origins(repair.id)) {
      const item = this.host.getItem(origin.itemId), run = this.host.getRun(item.runId);
      if (activeOrigin(origin) && (run.status === 'cancelled' || item.state === 'skipped' || item.discardedAt)) store.setOriginState(origin, 'withdrawn');
      else if (origin.state === 'retrying' && origin.verification?.checkpoint === item.checkpointCommit
        && item.state === 'landed' && item.verdict?.verdict === 'PASS') store.setOriginState(origin, 'passed');
    }
    const origins = store.origins(repair.id), active = origins.filter(activeOrigin);
    if (!active.length) {
      const run = repair.repairRunId ? this.host.store.getRun(repair.repairRunId) : undefined;
      if (run && !repair.ownerRun && ['running', 'paused'].includes(run.status)) await this.hooks.controlRun(run.id, 'cancel');
      store.save({ ...store.get(repair.id)!, state: origins.some(origin => origin.state === 'passed') ? 'resolved' : 'cancelled', detail: 'Every originating check passed or was withdrawn.' });
      return;
    }
    const runnable = active.filter(origin => this.host.getRun(this.host.getItem(origin.itemId).runId).status !== 'paused');
    if (!repair.repairRunId || !this.host.store.getRun(repair.repairRunId)) {
      if (!runnable.length || !technical(repair.gap)) return;
      if (active.some(origin => this.host.getItem(origin.itemId).state !== 'parked' || !this.hooks.sourceSettled(origin.itemId))) return;
      if (repair.gap.repairRepository && repair.gap.repairRepository !== repair.repository) {
        this.handoff(repair, `The repair belongs to ${repair.gap.repairRepository}. Its owner must take the linked plan; this source repository was not authorised to implement it.`); return;
      }
      const source = this.host.getRun(repair.sourceRunId);
      if (source.config.capabilityRepairRepository !== repair.repository) {
        this.handoff(repair, 'The owning session must explicitly authorise repairs in this repository. Cross-project work requires its owner’s handoff.'); return;
      }
      // A failed launch waits for explicit owner re-authorisation, never a timer-driven retry storm.
      if (repair.state === 'waiting') return;
      await this.launch(this.host, repair, () => store.origins(repair.id).filter(activeOrigin).every(origin => this.hooks.sourceSettled(origin.itemId))); return;
    }
    const run = this.host.getRun(repair.repairRunId), item = this.host.getItem(repair.repairItemId!);
    const landedByOwner = landedInOwnerRun(repair, item.state);
    if ((run.status === 'cancelled' && !landedByOwner) || item.discardedAt || item.state === 'skipped') {
      store.save({ ...repair, state: 'cancelled', detail: 'The owner cancelled the repair; repeated observations do not restart it.' }); return;
    }
    if (!runnable.length && run.status === 'running' && !repair.ownerRun) {
      await this.hooks.controlRun(run.id, 'pause'); const latest = store.get(repair.id)!;
      if (!latest.operatorPaused) store.save({ ...latest, autoPaused: true }); return;
    }
    if (runnable.length && repair.autoPaused && !repair.ownerRun && !repair.operatorPaused && run.status === 'paused') {
      await this.hooks.controlRun(run.id, 'resume'); store.save({ ...store.get(repair.id)!, autoPaused: false }); return;
    }
    if (run.status === 'paused' && !landedByOwner) return;
    // Earlier repairs in this pass may have awaited, and a cancel may have arrived meanwhile: act on the saved record.
    const current = store.get(repair.id)!;
    if (current.state === 'cancelled' || current.state === 'resolved') return;
    if (item.state === 'parked') {
      store.save({ ...current, state: 'waiting', detail: 'The repair is set aside. Its owner may resume the existing job; another job is not created.' }); return;
    }
    // A failed rerun or an error after landing waits for its owner.
    if (item.state !== 'landed' || heldForOwner(current)) return;
    // The repair is on the base branch. Each original check is rerun on the merged code and passes only with its own
    // independent checker's evidence, so other work landing alongside the repair does not hold the originals back.
    if (current.state !== 'verifying-origin') {
      store.save({ ...current, state: 'verifying-origin', detail: 'The repair landed. Rechecking the original acceptance criteria.' });
    }
    for (const itemId of new Set(runnable.filter(origin => origin.state === 'waiting').map(origin => origin.itemId))) {
      const linked = store.forOrigin(itemId).filter(other => technical(other.gap));
      if (linked.some(other => other.state !== 'verifying-origin' && other.state !== 'resolved')) continue;
      // All checks share one durable handoff. A restart may replay it before or after
      // the item/run saves; the control path recognises an already resumed item.
      const pending = linked.flatMap(other => store.origins(other.id))
        .filter(origin => origin.itemId === itemId && origin.state === 'waiting');
      store.atomic(() => { for (const origin of pending) store.recordRetryIntent(origin); });
      if (!await this.hooks.retryOrigin(itemId)) continue;
      const original = this.host.getItem(itemId);
      if (['paused', 'cancelled'].includes(this.host.getRun(original.runId).status) || original.discardedAt || original.state === 'skipped') continue;
      if (linked.some(other => {
        const latest = store.get(other.id)!;
        return !['verifying-origin', 'resolved'].includes(latest.state) || (latest.repairRunId
          && !landedInOwnerRun(latest, this.host.getItem(latest.repairItemId!).state)
          && ['paused', 'cancelled'].includes(this.host.getRun(latest.repairRunId).status));
      })) continue;
      store.atomic(() => {
        for (const other of linked) for (const origin of store.origins(other.id)) {
          if (origin.itemId === itemId && origin.state === 'waiting' && origin.retryIntent) store.setOriginState(origin, 'retrying');
        }
      });
    }
  }
}
