/**
 * Plan Queue IPC handlers — the panel's view of runs and items, and James's
 * answers and controls. The panel is authoritative: IPC callers are the
 * operator, so there is no parent-session check here (MCP callers get one).
 */

import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  PlanQueueAnswerPayloadSchema,
  PlanQueueControlPayloadSchema,
  PlanQueueDiffstatPayloadSchema,
  PlanQueueGetPayloadSchema,
  PlanQueueListPayloadSchema,
  PlanQueueStartPayloadSchema,
  PlanQueueStartSetAsideAgentPayloadSchema,
  PlanQueueTicketAskAnswerPayloadSchema,
  PlanQueueTicketAskReadPayloadSchema,
  PlanQueuePreviewPayloadSchema,
  type PlanQueueStateChangedEvent,
} from '@contracts/schemas/plan-queue';
import { getPlanQueueCoordinator } from '../../plan-queue/plan-queue-coordinator';
import {
  getPlanQueueLiveTestFixtures,
  PlanQueueLiveTestFixtureRemoveSchema,
  PlanQueueLiveTestFixtureStartSchema,
} from '../../plan-queue/plan-queue-livetest-fixture';
import type { WindowManager } from '../../window-manager';
import { readTicketAsk } from '../../plan-queue/plan-queue-ticket-answer';
import { previewPlanQueueDocuments } from '../../plan-queue/plan-queue-discovery';
import { repositoryRoot } from '../../plan-queue/plan-queue-git';
import { handle } from './plan-queue-ipc-helpers';

export function registerPlanQueueHandlers(deps: { windowManager: WindowManager }): void {
  const coordinator = getPlanQueueCoordinator();

  coordinator.on('state-changed', (event: PlanQueueStateChangedEvent) => {
    deps.windowManager.sendToRenderer(IPC_CHANNELS.PLAN_QUEUE_STATE_CHANGED, event);
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_LIST, 'PLAN_QUEUE_LIST_FAILED', (payload) => {
    const validated = validateIpcPayload(PlanQueueListPayloadSchema, payload ?? {}, 'PLAN_QUEUE_LIST');
    if (!coordinator.isInitialized()) return { runs: [], alerts: [], health: null };
    return { runs: coordinator.listRunDtos(validated.limit), alerts: coordinator.getAlerts(), health: coordinator.getQueueHealth() };
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_GET, 'PLAN_QUEUE_GET_FAILED', (payload) => {
    const validated = validateIpcPayload(PlanQueueGetPayloadSchema, payload, 'PLAN_QUEUE_GET');
    return { run: coordinator.getRunDto(validated.runId) };
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_ALERTS, 'PLAN_QUEUE_ALERTS_FAILED', async () => ({
    alerts: await coordinator.refreshAlerts(),
  }));

  handle(IPC_CHANNELS.PLAN_QUEUE_DIFFSTAT, 'PLAN_QUEUE_DIFFSTAT_FAILED', async (payload) => {
    const validated = validateIpcPayload(PlanQueueDiffstatPayloadSchema, payload, 'PLAN_QUEUE_DIFFSTAT');
    return { diffstat: await coordinator.diffstat(validated.itemId) };
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_START, 'PLAN_QUEUE_START_FAILED', async (payload) => {
    const validated = validateIpcPayload(PlanQueueStartPayloadSchema, payload, 'PLAN_QUEUE_START');
    return coordinator.startRun(validated);
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_START_SET_ASIDE_AGENT, 'PLAN_QUEUE_START_SET_ASIDE_AGENT_FAILED', async (payload) => {
    const validated = validateIpcPayload(PlanQueueStartSetAsideAgentPayloadSchema, payload, 'PLAN_QUEUE_START_SET_ASIDE_AGENT');
    return { instanceId: await coordinator.setAsideAgents.start(validated.workspaceCwd) };
  });

  // Live-test copies only; the fixtures refuse everywhere else (plan-queue-livetest-fixture.ts).
  const fixtures = () => getPlanQueueLiveTestFixtures(coordinator);
  handle(IPC_CHANNELS.PLAN_QUEUE_LIVETEST_FIXTURE_START, 'PLAN_QUEUE_LIVETEST_FIXTURE_START_FAILED', (payload) =>
    fixtures().start(validateIpcPayload(PlanQueueLiveTestFixtureStartSchema, payload, 'PLAN_QUEUE_LIVETEST_FIXTURE_START')));
  handle(IPC_CHANNELS.PLAN_QUEUE_LIVETEST_FIXTURE_REMOVE, 'PLAN_QUEUE_LIVETEST_FIXTURE_REMOVE_FAILED', (payload) =>
    fixtures().remove(validateIpcPayload(PlanQueueLiveTestFixtureRemoveSchema, payload, 'PLAN_QUEUE_LIVETEST_FIXTURE_REMOVE').fixtureId));
  handle(IPC_CHANNELS.PLAN_QUEUE_LIVETEST_FIXTURE_LIST, 'PLAN_QUEUE_LIVETEST_FIXTURE_LIST_FAILED', () => ({ fixtures: fixtures().list() }));

  handle(IPC_CHANNELS.PLAN_QUEUE_PREVIEW, 'PLAN_QUEUE_PREVIEW_FAILED', async (payload) => {
    const validated = validateIpcPayload(PlanQueuePreviewPayloadSchema, payload, 'PLAN_QUEUE_PREVIEW');
    return previewPlanQueueDocuments(await repositoryRoot(validated.workspaceCwd), validated.kind, validated.glob);
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_ANSWER, 'PLAN_QUEUE_ANSWER_FAILED', async (payload) => {
    const validated = validateIpcPayload(PlanQueueAnswerPayloadSchema, payload, 'PLAN_QUEUE_ANSWER');
    await coordinator.answer(validated.itemId, validated.optionId);
    return null;
  });

  // The question about a Linear ticket that changed. These two channels answer the page only: the held text is read here and
  // nowhere else, and `plan_queue_answer`, the phone and every session refuse the question (plan-queue-ticket-answer.ts).
  handle(IPC_CHANNELS.PLAN_QUEUE_TICKET_ASK_READ, 'PLAN_QUEUE_TICKET_ASK_READ_FAILED', (payload) => {
    const validated = validateIpcPayload(PlanQueueTicketAskReadPayloadSchema, payload, 'PLAN_QUEUE_TICKET_ASK_READ');
    return { ask: readTicketAsk(validated.itemId) };
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_TICKET_ASK_ANSWER, 'PLAN_QUEUE_TICKET_ASK_ANSWER_FAILED', async (payload) => {
    const validated = validateIpcPayload(PlanQueueTicketAskAnswerPayloadSchema, payload, 'PLAN_QUEUE_TICKET_ASK_ANSWER');
    await coordinator.answerTicketAsk(validated);
    return null;
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_CONTROL, 'PLAN_QUEUE_CONTROL_FAILED', async (payload) => {
    const validated = validateIpcPayload(PlanQueueControlPayloadSchema, payload, 'PLAN_QUEUE_CONTROL');
    await coordinator.control(validated);
    return null;
  });
}
