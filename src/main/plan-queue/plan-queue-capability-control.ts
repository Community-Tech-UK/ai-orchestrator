import * as fs from 'node:fs/promises';
import { repositoryRoot } from './plan-queue-git';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueRun } from './plan-queue.types';
import { heldForOwner, landedInOwnerRun } from './plan-queue-capability-store';
import { findProjectFiles } from './plan-queue-source-presence';
import type { PlanQueueAccountRules } from '@contracts/schemas/plan-queue';
import { mergePlanQueueAccountRules } from './plan-queue-account-rules';
import { AUTOMATION_PROVIDER_IDS } from '../../shared/types/automation-provider.types';
import { defaultPlanQueueRoutingDeps, type PlanQueueRoutingDeps } from './plan-queue-routing';

export function capabilityProviderExclusions(routing: PlanQueueRoutingDeps | undefined): string[] {
  return AUTOMATION_PROVIDER_IDS.filter(provider => (routing ?? defaultPlanQueueRoutingDeps()).isProviderExcluded(provider));
}

export function capabilityAccountRulesFor(host: PlanQueueFlowHost, instanceId: string, current: PlanQueueAccountRules): PlanQueueAccountRules {
  const metadataRun = host.instances.getInstance(instanceId)?.metadata?.['planQueueRunId'];
  const runId = host.roleOf(instanceId)?.runId ?? (typeof metadataRun === 'string' ? metadataRun : undefined);
  return mergePlanQueueAccountRules(current, runId ? host.store.getRun(runId)?.config.capabilityRepairAccountRules : undefined);
}

export function noteCapabilityControl(host: PlanQueueFlowHost, runId: string, action: string): void {
  const id = host.getRun(runId).config.capabilityRepairId;
  const repair = id && host.store.capabilities.get(id);
  if (!repair || !['pause', 'resume', 'resume-item', 'retry-landing', 'land-anyway', 'cancel'].includes(action)) return;
  // Sending a set-aside repair to merge makes it active again, so a clash its worker fixes is not re-parked as waiting.
  // A cancelled or finished repair stays as it is.
  if ((action === 'retry-landing' || action === 'land-anyway') && repair.state !== 'waiting') return;
  const resumed = action !== 'pause' && action !== 'cancel';
  host.store.capabilities.save({ ...repair, autoPaused: false, operatorPaused: action === 'pause',
    state: action === 'cancel' ? 'cancelled' : resumed ? 'running' : repair.state, heldForOwner: resumed ? false : repair.heldForOwner });
}

/** Resuming an original job is its owner's release for a landed repair held after a failed rerun or an error. */
export function releaseHeldCapabilityRepairs(host: PlanQueueFlowHost, itemId: string): void {
  for (const repair of host.store.capabilities.forOrigin(itemId)) {
    if (repair.state === 'cancelled' || repair.state === 'resolved' || !heldForOwner(repair) || !repair.repairItemId || host.store.getItem(repair.repairItemId)?.state !== 'landed') continue;
    host.store.capabilities.save({ ...repair, heldForOwner: false, state: 'verifying-origin',
      detail: 'Its owner resumed the original job. Rechecking the original acceptance criteria.' });
  }
}

/** A resumed job: an active repair again if it is one, and the owner's release for any held repair it waits on. */
export function noteResumedCapabilityItem(host: PlanQueueFlowHost, runId: string, itemId: string): void {
  noteCapabilityControl(host, runId, 'resume-item');
  releaseHeldCapabilityRepairs(host, itemId);
}

/** Called only after the ordinary parent-control check, and checked again after canonicalising paths. */
export async function enableCapabilityRepairs(host: PlanQueueFlowHost, runId: string, repository: string, authorize: () => unknown): Promise<void> {
  const target = await fs.realpath(await repositoryRoot(repository));
  const root = await fs.realpath(host.getRun(runId).workspaceCwd);
  authorize();
  const run = host.getRun(runId);
  if (run.config.capabilityRepairId) throw new Error('A repair run cannot authorise another repair.');
  if (run.status === 'cancelled') throw new Error('A cancelled source run cannot authorise capability repairs.');
  if (target !== root) throw new Error('Automatic capability repairs are restricted to this run’s repository. Cross-project repairs require an owner handoff.');
  host.store.upsertRun({ ...run, config: { ...run.config, capabilityRepairRepository: target } });
  for (const item of host.store.listItems(runId)) for (const repair of host.store.capabilities.forOrigin(item.id)) {
    if ((!repair.repairRunId || !host.store.getRun(repair.repairRunId)) && repair.state === 'waiting' && repair.sourceRunId === runId) {
      host.store.capabilities.save({ ...repair, state: 'planned', detail: 'The owner authorised this repository; the existing repair plan will be attempted again.' });
    }
  }
}

/**
 * A job parked on a missing setup is not sent back to a checkout with no application in it: it would find the same
 * gap and report it again. Only a `setup` gap is judged (a missing control does not depend on this checkout), and the
 * owner's own resume of the job is never blocked. The reason names where the application lives when the report did.
 */
async function missingSourceProblem(host: PlanQueueFlowHost, itemId: string): Promise<string | null> {
  const waiting = host.store.capabilities.forOrigin(itemId).filter(repair => repair.gap.classification === 'setup'
    && host.store.capabilities.origins(repair.id).some(origin => origin.itemId === itemId && origin.state === 'waiting'));
  if (!waiting.length) return null;
  const workspace = host.getRun(host.getItem(itemId).runId).workspaceCwd;
  if ((await findProjectFiles(workspace)).length) return null;
  const owners = [...new Set(waiting.map(repair => repair.gap.repairRepository).filter((repository): repository is string => !!repository && repository !== workspace))];
  return `The original check was not sent again: ${workspace} holds no application to run it on (no package.json or similar project file), so it would report the same missing setup.`
    + (owners.length ? ` The application is in ${owners.join(' or ')}: start a run there with plan_queue_start.` : ' Start a run in the folder that holds the application.');
}

export async function retryCapabilityOrigin(host: PlanQueueFlowHost, itemId: string,
  resume: (id: string, canResume: () => boolean) => Promise<void>, reopen: (run: PlanQueueRun) => void): Promise<boolean> {
  const admitted = (): boolean => {
    const item = host.getItem(itemId), run = host.getRun(item.runId);
    if (run.status === 'paused' || run.status === 'cancelled' || item.discardedAt || item.state === 'skipped') return false;
    return host.store.capabilities.forOrigin(itemId).filter(repair => repair.gap.classification === 'capability' || repair.gap.classification === 'setup')
      .every(repair => (repair.state === 'verifying-origin' || repair.state === 'resolved')
        && (!repair.repairRunId || landedInOwnerRun(repair, host.getItem(repair.repairItemId!).state)
          || !['paused', 'cancelled'].includes(host.getRun(repair.repairRunId).status)));
  };
  if (!admitted()) return false;
  const item = host.getItem(itemId);
  const intended = host.store.capabilities.forOrigin(itemId).some(repair => host.store.capabilities.origins(repair.id)
    .some(origin => origin.itemId === itemId && origin.state === 'waiting' && origin.retryIntent));
  if (!intended) throw new Error('The original item has no recorded capability retry.');
  if (item.state === 'parked') {
    if (item.parkReason !== 'needs-setup') return false;
    const problem = await missingSourceProblem(host, item.id);
    if (problem) throw new Error(problem);
    if (item.branchName || item.worktreePath) await resume(item.id, () => admitted() && host.getItem(itemId).state === 'parked'
      && host.getItem(itemId).parkReason === 'needs-setup');
    else host.transition(item, 'discovered', { question: null, parkReason: null, detail: 'Its capability repair passed. Investigate current readiness and rerun the original check; no check has been marked passed.' });
  }
  // Resume can be interrupted by operator control during retained-work I/O.
  // An already queued/discovered item is a successful replay, never resumed twice.
  if (!admitted() || host.getItem(itemId).state === 'parked') return false;
  reopen(host.getRun(item.runId));
  return true;
}
