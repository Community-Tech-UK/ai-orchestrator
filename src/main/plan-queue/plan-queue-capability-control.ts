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

export async function retryCapabilityOrigin(host: PlanQueueFlowHost, itemId: string, resume: (id: string) => Promise<void>, reopen: (run: PlanQueueRun) => void): Promise<void> {
  const item = host.getItem(itemId), run = host.getRun(item.runId);
  if (run.status === 'paused' || run.status === 'cancelled' || item.discardedAt || item.state !== 'parked') throw new Error('The original item is paused, cancelled, discarded or no longer waiting for repair.');
  if (item.branchName || item.worktreePath) await resume(item.id);
  else host.transition(item, 'discovered', { question: null, parkReason: null, detail: 'Its capability repair passed. Investigate current readiness and rerun the original check; no check has been marked passed.' });
  reopen(run);
}
