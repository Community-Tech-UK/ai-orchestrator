/** Validate and create a run without yielding between document ownership checks and item writes. */
import { realpathSync } from 'node:fs';
import type { PlanQueueRunConfig } from '@contracts/schemas/plan-queue';
import type { PlanQueueCoordinatorDeps, StartRunInput, StartRunResult } from './plan-queue-coordinator';
import { getLogger } from '../logging/logger';
import { AUTOMATION_PROVIDER_IDS } from '../../shared/types/automation-provider.types';
import { isProviderExcludedFromAutomation } from '../providers/automation-provider-exclusions';
import { preflightPlanQueueRun } from './plan-queue-run-preflight';
import { assertRunReady } from './plan-queue-run-readiness';
import { claimDocumentsAndCreateItems } from './plan-queue-run-start';
import { workSourceForRun } from './plan-queue-work-sources';
import { defaultRunConfigFor } from './plan-queue-default-gates';
import { resolveRunGates, savedChecklistFor } from './plan-queue-folder-checklists';
import { isExactPlanQueueSelection } from './plan-queue-discovery-paths';
import { currentBranch, repositoryRoot } from './plan-queue-git';
import { assertRoutingInstalled, resolveRunRouting } from './plan-queue-routing';
import type { PlanQueueRun } from './plan-queue.types';
import type { VerifierSelectInput, VerifierSelection } from './plan-queue-verifier-select';

const logger = getLogger('PlanQueueCoordinator');
type RunCreateHost = Pick<PlanQueueCoordinatorDeps, 'store' | 'instances' | 'routing'>
  & Required<Pick<PlanQueueCoordinatorDeps, 'folderChecklists' | 'thisRepositoryRootCommit' | 'now' | 'newId'>> & {
    isQueueInstance(instanceId: string): boolean;
    isSetAsideInstance(instanceId: string): boolean;
    selectVerifier(input: VerifierSelectInput): Promise<VerifierSelection>;
    applyRelaxation(run: PlanQueueRun): void;
  };

/** Both `plan_queue_start` and the page's ordinary Start reach `createPlanQueueRun`, so this one sentence covers both. */
export const LINEAR_RUN_PAGE_ONLY_MESSAGE = 'Linear runs start only on the Plan Queue page, where James ticks the tickets.';

export async function createPlanQueueRun(input: StartRunInput, host: RunCreateHost): Promise<Omit<StartRunResult, 'run'> & { run: PlanQueueRun }> {
  // First, before anything is read: a Linear run is made by its own function (Step 11), never from these arguments.
  if (input.kind === 'tickets' || input.config?.linear !== undefined) throw new Error(LINEAR_RUN_PAGE_ONLY_MESSAGE);
  if (input.config?.capabilityRepairId !== undefined || input.config?.capabilityRepairAccountRules !== undefined
    || input.config?.startingProviderExclusions !== undefined || input.config?.capabilityRepairExcludedProviders !== undefined) {
    throw new Error('Repair identity and inherited account restrictions are assigned only by the coordinator.');
  }
  const startingProviderExclusions = AUTOMATION_PROVIDER_IDS.filter(host.routing?.isProviderExcluded ?? isProviderExcludedFromAutomation);
  const parent = host.instances.getInstance(input.parentInstanceId);
  if (!parent) throw new Error(`Parent session not found: ${input.parentInstanceId}`);
  if (host.isQueueInstance(input.parentInstanceId) || host.isSetAsideInstance(input.parentInstanceId)) {
    throw new Error('A Plan Queue worker, verifier, triage or Set aside session cannot start another queue run');
  }
  const startFolder = input.workspaceCwd ?? parent.workingDirectory ?? process.cwd();
  const repoRoot = await repositoryRoot(startFolder);
  const repairRepository = input.config?.capabilityRepairRepository === undefined ? undefined
    : realpathSync(await repositoryRoot(input.config.capabilityRepairRepository));
  if (repairRepository !== undefined && repairRepository !== realpathSync(repoRoot)) {
    throw new Error('Automatic capability repairs are restricted to this run’s repository. Cross-project repairs require an owner handoff.');
  }
  const baseBranch = await currentBranch(repoRoot);
  if (!baseBranch) throw new Error(`${repoRoot} is not on a branch; the queue lands work on the checked-out branch`);

  // Fixed now, validated now: a choice the queue cannot honour refuses the run.
  const { routing, setAside, accountNotes } = resolveRunRouting(parent, { ...input.routing, relaxExclusions: input.config?.relaxSettings === true, workspaceCwd: repoRoot }, host.routing);
  await assertRoutingInstalled(routing, host.routing ?? {});
  await preflightPlanQueueRun({ routing, workspaceCwd: repoRoot, workerProvider: parent.provider ?? 'claude', workerModel: parent.currentModel ?? null,
    selectVerifier: input => host.selectVerifier(input) });
  const glob = input.glob ?? input.config?.glob;
  const defaults = await defaultRunConfigFor(repoRoot, input.kind, host.thisRepositoryRootCommit);
  const { callerGatesSetAside, ...gates } = resolveRunGates(defaults, input.config, savedChecklistFor(host.folderChecklists(), repoRoot, startFolder));
  const config: PlanQueueRunConfig = { ...defaults, ...input.config, ...gates, glob, baseBranch, routing, startingProviderExclusions, ...(repairRepository === undefined ? {} : { capabilityRepairRepository: repairRepository }), startingSessionRoute: { provider: parent.provider, currentModel: parent.currentModel, accountProfileId: parent.accountProfileId, copilotAccountProfileId: parent.copilotAccountProfileId } };
  await assertRunReady(repoRoot, [...config.verifierGates, ...config.postMergeGate]);
  const documents = await workSourceForRun({ kind: input.kind }).discover(repoRoot, { kind: input.kind, glob });
  // No await from here until the items are written: reading the owned set and
  // claiming documents is atomic on the main thread, so two concurrent starts
  // cannot both claim one document.
  const now = host.now();
  const run: PlanQueueRun = {
    id: host.newId(),
    parentInstanceId: input.parentInstanceId,
    parentHistoryThreadId: parent.historyThreadId?.trim() || null,
    kind: input.kind,
    workspaceCwd: repoRoot,
    status: 'running',
    config,
    relaxation: null,
    workerProvider: routing.workers[0]?.provider ?? null,
    workerModel: routing.workers[0]?.model ?? null,
    startedAt: now,
    endedAt: null,
  };
  host.store.upsertRun(run);
  if (config.relaxSettings) host.applyRelaxation(run);
  const excluded = claimDocumentsAndCreateItems({ store: host.store, memory: host.store.history, now: host.now, newId: host.newId },
    run, documents, { queueDirectly: isExactPlanQueueSelection(glob) });
  const items = host.store.listItems(run.id);
  logger.info('Plan queue run started', { runId: run.id, kind: run.kind, items: items.length, excluded: excluded.length });
  return { run, excluded, routingSetAside: setAside, accountNotes, checklistSetAside: callerGatesSetAside };
}
