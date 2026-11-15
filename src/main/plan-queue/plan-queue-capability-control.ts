import * as fs from 'node:fs/promises';
import { repositoryRoot } from './plan-queue-git';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueRun } from './plan-queue.types';
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
  if (!repair || !['pause', 'resume', 'resume-item', 'cancel'].includes(action)) return;
  host.store.capabilities.save({ ...repair, autoPaused: false, operatorPaused: action === 'pause',
    state: action === 'cancel' ? 'cancelled' : action === 'resume' || action === 'resume-item' ? 'running' : repair.state });
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

export async function retryCapabilityOrigin(host: PlanQueueFlowHost, itemId: string,
  resume: (id: string, canResume: () => boolean) => Promise<void>, reopen: (run: PlanQueueRun) => void): Promise<boolean> {
  const admitted = (): boolean => {
    const item = host.getItem(itemId), run = host.getRun(item.runId);
    if (run.status === 'paused' || run.status === 'cancelled' || item.discardedAt || item.state === 'skipped') return false;
    return host.store.capabilities.forOrigin(itemId).filter(repair => repair.gap.classification === 'capability' || repair.gap.classification === 'setup')
      .every(repair => (repair.state === 'verifying-origin' || repair.state === 'resolved')
        && (!repair.repairRunId || !['paused', 'cancelled'].includes(host.getRun(repair.repairRunId).status)));
  };
  if (!admitted()) return false;
  const item = host.getItem(itemId);
  const intended = host.store.capabilities.forOrigin(itemId).some(repair => host.store.capabilities.origins(repair.id)
    .some(origin => origin.itemId === itemId && origin.state === 'waiting' && origin.retryIntent));
  if (!intended) throw new Error('The original item has no recorded capability retry.');
  if (item.state === 'parked') {
    if (item.parkReason !== 'needs-setup') return false;
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
