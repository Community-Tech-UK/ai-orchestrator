import type { AutomationRun } from '../../shared/types/automation.types';
import type { AppState } from '../state';
import type { InstanceManager } from '../instance/instance-manager';
import type { LoopState } from '../../shared/types/loop.types';
import type {
  StateSyncSnapshot,
  ThinClientAutomationRunSnapshot,
  ThinClientLoopRunSnapshot,
  ThinClientPauseStateSnapshot,
} from '../../shared/types/thin-client-event.types';
import {
  automationRunStatusToPhase,
  loopStatusToPhase,
} from '../../shared/types/workflow-lifecycle.types';
import { getAutomationStore } from '../automations';
import { getLoopCoordinator } from '../orchestration/loop-coordinator';
import { getPauseCoordinator } from '../pause/pause-coordinator';
import { getAppStore, type Store } from '../state';

const ACTIVE_AUTOMATION_STATUSES = new Set<AutomationRun['status']>(['pending', 'running']);

export interface StateSyncSnapshotDeps {
  instanceManager: Pick<InstanceManager, 'getAllInstancesForIpc'>;
  loopCoordinator?: { getActiveLoops(): LoopState[] };
  automationStore?: {
    listActiveRuns?: () => AutomationRun[];
    listRuns(options?: { limit?: number }): AutomationRun[];
  };
  pauseCoordinator?: { toPayload(): ThinClientPauseStateSnapshot };
  appStore?: Pick<Store<AppState>, 'getState'>;
  getSeq: () => number;
}

export function buildStateSyncSnapshot(deps: StateSyncSnapshotDeps): StateSyncSnapshot {
  if (typeof deps.getSeq !== 'function') {
    throw new Error('State sync snapshots require a caller-scoped sequence supplier');
  }
  const appState = (deps.appStore ?? getAppStore()).getState();
  return {
    instances: deps.instanceManager.getAllInstancesForIpc(),
    loopRuns: (deps.loopCoordinator ?? getLoopCoordinator())
      .getActiveLoops()
      .map(toLoopSnapshot),
    automationRuns: getActiveAutomationRuns(deps.automationStore ?? getAutomationStore())
      .map(toAutomationRunSnapshot),
    pauseState: (deps.pauseCoordinator ?? getPauseCoordinator()).toPayload(),
    memoryPressure: appState.global.memoryPressure,
    seq: deps.getSeq(),
  };
}

function getActiveAutomationRuns(
  automationStore: NonNullable<StateSyncSnapshotDeps['automationStore']>,
): AutomationRun[] {
  if (automationStore.listActiveRuns) {
    return automationStore.listActiveRuns();
  }
  return automationStore
    .listRuns({ limit: 200 })
    .filter((run) => ACTIVE_AUTOMATION_STATUSES.has(run.status));
}

function toLoopSnapshot(loop: LoopState): ThinClientLoopRunSnapshot {
  return {
    loopRunId: loop.id,
    chatId: loop.chatId,
    status: loop.status,
    phase: loopStateToPhase(loop),
    totalIterations: loop.totalIterations,
    totalTokens: loop.totalTokens,
    totalCostCents: loop.totalCostCents,
    startedAt: loop.startedAt,
    endedAt: loop.endedAt,
    endReason: loop.endReason ?? null,
    initialPrompt: loop.config.initialPrompt,
    iterationPrompt: loop.config.iterationPrompt ?? null,
    workspaceCwd: loop.config.workspaceCwd,
  };
}

function loopStateToPhase(loop: Pick<LoopState, 'status' | 'endedAt'>): ThinClientLoopRunSnapshot['phase'] {
  if (loop.status === 'provider-limit' && loop.endedAt != null) {
    return 'failed';
  }
  return loopStatusToPhase(loop.status);
}

function toAutomationRunSnapshot(run: AutomationRun): ThinClientAutomationRunSnapshot {
  return {
    runId: run.id,
    automationId: run.automationId,
    status: run.status,
    phase: automationRunStatusToPhase(run.status),
    instanceId: run.instanceId,
    scheduledAt: run.scheduledAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}
