import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { CapabilityRepair } from './plan-queue-capability-store';
import { ensureCapabilityPlan } from './plan-queue-capability-plan';
import { preflightResumedRun } from './plan-queue-run-preflight';
import { assertRoutingInstalled, defaultPlanQueueRoutingDeps } from './plan-queue-routing';
import { newPlanQueueItem } from './plan-queue-state';
import type { PlanQueueRun } from './plan-queue.types';
import { repositoryRoot } from './plan-queue-git';
import { defaultRunConfigFor, THIS_REPOSITORY_ROOT_COMMIT } from './plan-queue-default-gates';
import { readSavedFolderChecklists, resolveRunGates, savedChecklistFor } from './plan-queue-folder-checklists';

/** Internal derived run: fixed original policy, normal scheduling and landing, never fresh parent defaults. */
export async function launchCapabilityRun(host: PlanQueueFlowHost, repair: CapabilityRepair, sourcesSettled: () => boolean): Promise<void> {
  const source = host.getRun(repair.sourceRunId);
  const parent = host.liveParentId(source);
  if (!parent) throw new Error('The owning session is unavailable; the repair keeps its original owner.');
  if (source.config.capabilityRepairId) throw new Error('A capability repair cannot start another repair.');
  if (repair.gap.repairRepository && repair.gap.repairRepository !== repair.repository) throw new Error('A cross-project capability repair requires its owner’s handoff.');
  if (await fs.realpath(await repositoryRoot(source.workspaceCwd)) !== repair.repository) throw new Error('The source repository moved; its repair authority does not follow a different folder.');
  const defaults = await defaultRunConfigFor(repair.repository, 'plans', THIS_REPOSITORY_ROOT_COMMIT);
  const gates = resolveRunGates(defaults, undefined, savedChecklistFor(readSavedFolderChecklists(), repair.repository, repair.repository));
  // Persist intent before launch side effects. Recovery reuses these exact identities.
  repair = { ...repair, repairRunId: repair.repairRunId ?? randomUUID(), repairItemId: repair.repairItemId ?? randomUUID() };
  host.store.capabilities.save(repair);
  const run: PlanQueueRun = {
    ...source, id: repair.repairRunId!, parentInstanceId: parent, kind: 'plans', status: 'running',
    workspaceCwd: repair.repository, startedAt: Date.now(), endedAt: null, holdReason: null, relaxation: null,
    config: { ...repair.config, capabilityRepairId: repair.id, capabilityRepairRepository: undefined,
      capabilityRepairAccountRules: repair.accountRules, relaxSettings: false,
      verifierGates: [...new Set([...gates.verifierGates, ...repair.config.verifierGates])],
      postMergeGate: [...new Set([...gates.postMergeGate, ...repair.config.postMergeGate])],
      glob: path.relative(repair.repository, repair.planPath).split(path.sep).join('/') },
  };
  await assertRoutingInstalled(run.config.routing ?? { workers: [], verifiers: [] }, defaultPlanQueueRoutingDeps());
  await preflightResumedRun(run, input => host.selectVerifier(input));
  await ensureCapabilityPlan(repair);
  // An owner may pause/cancel while preflight awaits. Do not commit an unwanted launch.
  if (await fs.realpath(await repositoryRoot(host.getRun(source.id).workspaceCwd)) !== repair.repository) throw new Error('The authorised repository changed during repair preflight.');
  const current = host.store.capabilities.get(repair.id)!;
  if (host.liveParentId(host.getRun(source.id)) !== parent) throw new Error('The source owner changed during repair preflight; its current owner must retry the existing plan.');
  if (host.store.capabilities.origins(repair.id).some(origin => origin.state === 'waiting' && host.getItem(origin.itemId).state !== 'parked')) return;
  if (!sourcesSettled() || current.state === 'cancelled' || !host.store.capabilities.origins(repair.id).some(origin => {
    const item = host.store.getItem(origin.itemId);
    const run = item && host.store.getRun(item.runId);
    return origin.state === 'waiting' && run && run.status !== 'paused' && run.status !== 'cancelled';
  })) return;
  host.store.capabilities.atomic(() => {
    if (!host.store.getRun(run.id)) host.store.upsertRun(run);
    if (!host.store.getItem(repair.repairItemId!)) host.store.upsertItem(newPlanQueueItem(repair.repairItemId!, run.id, repair.planPath, Date.now(), { state: 'queued' }));
    host.store.capabilities.save({ ...current, state: 'running', detail: 'The bounded repair plan is running under the original account and computer restrictions.' });
  });
  host.notifyParent(source, `A missing test control has its own repair plan: ${repair.planPath}. The original check is still unverified.`);
  host.requestPump();
}
