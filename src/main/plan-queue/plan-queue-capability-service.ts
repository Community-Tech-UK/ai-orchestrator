import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PlanQueueAccountRules, PlanQueueCapabilityGap, PlanQueueReportCapabilityGapArgs,
  PlanQueueReportCapabilityProbeArgs, PlanQueueReportCapabilityCheckArgs } from '@contracts/schemas/plan-queue';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { CapabilityRepair, CapabilityOrigin } from './plan-queue-capability-store';
import { launchCapabilityRun } from './plan-queue-capability-launch';
import { ensureCapabilityPlan, validateCapabilityProbe } from './plan-queue-capability-plan';
import { gitExec } from '../workspace/git/git-exec';
import type { PlanQueueItem } from './plan-queue.types';
import { redactValue } from '../diagnostics/redaction';
import { repositoryRoot } from './plan-queue-git';

export interface CapabilityHooks {
  currentTriage(runId: string, instanceId: string, sourceRef: string): boolean;
  forgetTriage(runId: string, itemId: string): void;
  accountRules(): PlanQueueAccountRules;
  excludedProviders(): string[];
  sourceSettled(itemId: string): boolean;
  controlRun(runId: string, action: 'pause' | 'resume' | 'cancel'): Promise<void>;
  retryOrigin(itemId: string): Promise<void>;
}
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
    if (run.config.capabilityRepairId) {
      const own = this.host.store.capabilities.get(run.config.capabilityRepairId)!;
      this.host.store.capabilities.save({ ...own, state: 'waiting', detail: `This repair found a further prerequisite: ${args.gap.requiredAction}. No nested repair was started.` });
      return { repairId: own.id, state: 'waiting', message: 'Record the prerequisite and stop. The owner must resolve it; repairs never spawn repairs.' };
    }
    const repair = this.host.store.capabilities.attach({ repository, sourceRunId: run.id, itemId: item.id, gap,
      config: { ...run.config, capabilityRepairExcludedProviders: [...new Set([...(run.config.startingProviderExclusions ?? []), ...this.hooks.excludedProviders()])] },
      accountRules: this.hooks.accountRules(), planDirectory: 'docs/plans',
      reportedBy: { instanceId: caller, role: this.host.roleOf(caller)!.role, round: item.round, at: this.now() } });
    const retried = this.host.store.capabilities.origins(repair.id).find(origin => origin.itemId === item.id && origin.check === gap.check && origin.state === 'retrying');
    if (retried && technical(gap)) {
      this.host.store.capabilities.setOriginState(retried, 'waiting');
      const detail = 'The repaired control did not satisfy the original check. Its owner must investigate the new evidence and arrange a corrective plan; the landed repair is not retried blindly.';
      this.host.store.capabilities.save({ ...repair, state: 'waiting', detail });
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
    const repair = this.host.store.capabilities.forRepairItem(item.id);
    if (repair && (!repair.probeReceipt || repair.probeCheckedCommit !== item.checkpointCommit)) throw new Error('Report a fresh independent runtime probe for this repair checkpoint before PASS.');
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
    this.host.store.capabilities.save({ ...latest, probe: args.probe, probeCheckedTree: tree.trim(), probeCheckedCommit: item.checkpointCommit, probeReceipt: receipt });
    return { accepted: true, message: 'Runtime evidence retained. Independent PASS and unchanged verified landing are still required.' };
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
    for (const repair of this.host.store.capabilities.list()) {
      try { await this.reconcileOne(repair); }
      catch (error) {
        const current = this.host.store.capabilities.get(repair.id)!;
        if (current.state !== 'cancelled') this.host.store.capabilities.save({ ...current, state: 'waiting', detail: redactValue(error instanceof Error ? error.message : String(error), { homeDir: '' }) });
      }
      this.publishWaitingStatus(this.host.store.capabilities.get(repair.id)!);
    }
  }

  private publishWaitingStatus(repair: CapabilityRepair): void {
    const run = repair.repairRunId ? this.host.store.getRun(repair.repairRunId) : undefined;
    const item = repair.repairItemId ? this.host.store.getItem(repair.repairItemId) : undefined;
    const status = repair.state === 'cancelled' ? 'The repair was cancelled.' : run?.status === 'paused' ? 'The repair is paused.'
      : item?.state === 'working' || item?.state === 'fixing' ? 'The repair is being implemented.'
      : item?.state === 'verifying' ? 'The repair is under independent review.'
      : item?.state === 'queued' || item?.state === 'preparing' || item?.state === 'awaiting-slot' ? 'The repair is queued.'
      : repair.detail;
    for (const origin of this.host.store.capabilities.origins(repair.id)) {
      const original = this.host.getItem(origin.itemId);
      if (origin.state !== 'waiting' || original.state !== 'parked' || original.parkReason !== 'needs-setup') continue;
      const detail = `${status} Original check still open. Repair plan: ${repair.planPath}`;
      if (original.detail !== detail) this.host.save({ ...original, detail });
    }
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
      if (run && ['running', 'paused'].includes(run.status)) await this.hooks.controlRun(run.id, 'cancel');
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
    if (run.status === 'cancelled' || item.discardedAt || item.state === 'skipped') {
      store.save({ ...repair, state: 'cancelled', detail: 'The owner cancelled the repair; repeated observations do not restart it.' }); return;
    }
    if (!runnable.length && run.status === 'running') {
      await this.hooks.controlRun(run.id, 'pause'); const latest = store.get(repair.id)!;
      if (!latest.operatorPaused) store.save({ ...latest, autoPaused: true }); return;
    }
    if (runnable.length && repair.autoPaused && !repair.operatorPaused && run.status === 'paused') {
      await this.hooks.controlRun(run.id, 'resume'); store.save({ ...store.get(repair.id)!, autoPaused: false }); return;
    }
    if (run.status === 'paused') return;
    if (item.state === 'parked') {
      store.save({ ...repair, state: 'waiting', detail: 'The repair is set aside. Its owner may resume the existing job; another job is not created.' }); return;
    }
    if (item.state !== 'landed' || repair.state === 'waiting') return;
    if (item.verdict?.verdict !== 'PASS' || !repair.probe || !repair.probeReceipt || !item.checkpointCommit || !item.landedCommit) {
      store.save({ ...repair, state: 'waiting', detail: 'The repair landed without a matching independently checked runtime probe. The original checks remain open.' }); return;
    }
    const tree = (await gitExec(['rev-parse', `${item.checkpointCommit}^{tree}`], repair.repository)).trim();
    // Landing may close this one planning document; every other byte must still match the reviewed snapshot.
    const closedPlan = path.relative(repair.repository, repair.planPath).replace(/_plan\.md$/, '_plan_completed.md').split(path.sep).join('/');
    const changed = await gitExec(['diff', '--name-only', item.checkpointCommit, item.landedCommit, '--', '.', `:(exclude,literal)${closedPlan}`], repair.repository);
    const current = store.get(repair.id)!;
    if (current.state === 'cancelled' || ['cancelled', 'paused'].includes(this.host.getRun(run.id).status)) return;
    if (tree !== current.probeCheckedTree || changed.trim()) {
      store.save({ ...current, state: 'waiting', detail: 'Landing changed the reviewed runtime snapshot. A new runtime probe and review are required before retrying the original checks.' }); return;
    }
    store.save({ ...current, state: 'verifying-origin', detail: 'The repair passed review and runtime probing. Rechecking the original acceptance criteria.' });
    for (const itemId of new Set(runnable.filter(origin => origin.state === 'waiting').map(origin => origin.itemId))) {
      const linked = store.forOrigin(itemId).filter(other => technical(other.gap));
      if (linked.some(other => other.state !== 'verifying-origin' && other.state !== 'resolved')) continue;
      await this.hooks.retryOrigin(itemId);
      for (const other of linked) for (const origin of store.origins(other.id)) {
        if (origin.itemId === itemId && origin.state === 'waiting') store.setOriginState(origin, 'retrying');
      }
    }
  }
}
