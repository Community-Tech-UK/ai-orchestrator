/**
 * Plan Queue IPC handlers — the panel's view of runs and items, and James's
 * answers and controls. The panel is authoritative: IPC callers are the
 * operator, so there is no parent-session check here (MCP callers get one).
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  PlanQueueAnswerPayloadSchema,
  PlanQueueControlPayloadSchema,
  PlanQueueDiffstatPayloadSchema,
  PlanQueueGetPayloadSchema,
  PlanQueueListPayloadSchema,
  PlanQueueStartPayloadSchema,
  type PlanQueueStateChangedEvent,
} from '@contracts/schemas/plan-queue';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { getPlanQueueCoordinator } from '../../plan-queue/plan-queue-coordinator';
import type { WindowManager } from '../../window-manager';

function fail(code: string, error: unknown): IpcResponse {
  return { success: false, error: { code, message: (error as Error).message, timestamp: Date.now() } };
}

function handle(channel: string, code: string, fn: (payload: unknown) => Promise<unknown> | unknown): void {
  ipcMain.handle(channel, async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
    try {
      return { success: true, data: await fn(payload) };
    } catch (error) {
      return fail(code, error);
    }
  });
}

export function registerPlanQueueHandlers(deps: { windowManager: WindowManager }): void {
  const coordinator = getPlanQueueCoordinator();

  coordinator.on('state-changed', (event: PlanQueueStateChangedEvent) => {
    const run = coordinator.isInitialized() ? coordinator.getRunDto(event.runId) : null;
    deps.windowManager.sendToRenderer(IPC_CHANNELS.PLAN_QUEUE_STATE_CHANGED, { ...event, run });
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_LIST, 'PLAN_QUEUE_LIST_FAILED', (payload) => {
    const validated = validateIpcPayload(PlanQueueListPayloadSchema, payload ?? {}, 'PLAN_QUEUE_LIST');
    if (!coordinator.isInitialized()) return { runs: [], alerts: [] };
    return { runs: coordinator.listRunDtos(validated.limit), alerts: coordinator.getAlerts() };
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

  handle(IPC_CHANNELS.PLAN_QUEUE_ANSWER, 'PLAN_QUEUE_ANSWER_FAILED', async (payload) => {
    const validated = validateIpcPayload(PlanQueueAnswerPayloadSchema, payload, 'PLAN_QUEUE_ANSWER');
    await coordinator.answer(validated.itemId, validated.optionId);
    return null;
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_CONTROL, 'PLAN_QUEUE_CONTROL_FAILED', async (payload) => {
    const validated = validateIpcPayload(PlanQueueControlPayloadSchema, payload, 'PLAN_QUEUE_CONTROL');
    await coordinator.control(validated);
    return null;
  });
}
