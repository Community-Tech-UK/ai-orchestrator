import type { PlanQueueItemDto, PlanQueueRunDto, PlanQueueStateChangedEvent } from '@contracts/schemas/plan-queue';
import { getPlanQueueCoordinator } from '../plan-queue/plan-queue-coordinator';
import type { MobilePlanQueueItemDto, MobilePlanQueueRunDto } from '../../shared/types/mobile-gateway.types';
import { waitsForDirectChangeChoice } from '../../shared/types/mobile-gateway.types';
import { MobileRouteError } from './mobile-gateway-http-utils';
import type { GatewayPlanQueueSource } from './mobile-gateway-plan-queue-handlers';

function titleOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

export function projectPlanQueueItem(item: PlanQueueItemDto): MobilePlanQueueItemDto {
  return {
    id: item.id,
    runId: item.runId,
    title: titleOf(item.sourceRef),
    sourceRef: item.sourceRef,
    state: item.state,
    round: item.round,
    question: item.question,
    answer: item.answer,
    parkReason: item.parkReason,
    detail: item.detail,
    verdict: item.verdict?.verdict ?? null,
    workerInstanceId: item.workerInstanceId,
    updatedAt: item.updatedAt,
  };
}

export function projectPlanQueueRun(run: PlanQueueRunDto): MobilePlanQueueRunDto {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    workspaceCwd: run.workspaceCwd,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    workerProvider: run.workerProvider,
    workerModel: null,
    items: run.items.map(projectPlanQueueItem),
  };
}

export function createLivePlanQueueSource(): GatewayPlanQueueSource {
  const coordinator = getPlanQueueCoordinator();
  const list = () => coordinator.isInitialized() ? coordinator.listRunDtos(50).map(projectPlanQueueRun) : [];
  return {
    list,
    async answer(itemId, optionId) {
      await coordinator.answer(itemId, optionId);
    },
    async control(runId, action) {
      await coordinator.control({ action, runId });
    },
    async chooseDirectChange(itemId, choice) {
      if (!waitsForDirectChangeChoice(coordinator.getItem(itemId))) {
        throw new MobileRouteError('This job is not waiting for a choice about a direct change', 409);
      }
      // No caller, as from the Plan Queue page: only James's own controls may take the job's version.
      await coordinator.control(choice === 'take-job-version' ? { action: 'land-anyway', itemId } : { action: 'resume-item', itemId });
    },
    diffstat(itemId) {
      return coordinator.diffstat(itemId);
    },
    // Kept even with no phone connected: the item states it tracks decide the "needs an answer" push notifications.
    subscribe(listener) {
      const onChange = (event: PlanQueueStateChangedEvent) => {
        listener(event.runId, event.run ? projectPlanQueueRun(event.run) : null);
      };
      coordinator.on('state-changed', onChange);
      return () => coordinator.removeListener('state-changed', onChange);
    },
  };
}
