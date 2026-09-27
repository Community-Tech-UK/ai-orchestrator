import type { PlanQueueItemDto, PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import { getPlanQueueCoordinator } from '../plan-queue/plan-queue-coordinator';
import type { MobilePlanQueueItemDto, MobilePlanQueueRunDto } from '../../shared/types/mobile-gateway.types';
import type { GatewayPlanQueueSource } from './mobile-gateway-plan-queue-handlers';

function titleOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

export function projectPlanQueueItem(item: PlanQueueItemDto): MobilePlanQueueItemDto {
  return {
    id: item.id,
    runId: item.runId,
    title: titleOf(item.documentPath),
    documentPath: item.documentPath,
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
    diffstat(itemId) {
      return coordinator.diffstat(itemId);
    },
    subscribe(listener) {
      const onChange = (event: { runId: string }) => {
        const run = coordinator.isInitialized() ? coordinator.getRunDto(event.runId) : null;
        listener(event.runId, run ? projectPlanQueueRun(run) : null);
      };
      coordinator.on('state-changed', onChange);
      return () => coordinator.removeListener('state-changed', onChange);
    },
  };
}
