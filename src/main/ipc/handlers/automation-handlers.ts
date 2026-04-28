import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  AutomationCancelPendingPayloadSchema,
  AutomationCreatePayloadSchema,
  AutomationDeletePayloadSchema,
  AutomationGetPayloadSchema,
  AutomationListRunsPayloadSchema,
  AutomationMarkSeenPayloadSchema,
  AutomationRunNowPayloadSchema,
  AutomationUpdatePayloadSchema,
} from '@contracts/schemas/automation';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type { Automation } from '../../../shared/types/automation.types';
import { getSettingsManager } from '../../core/config/settings-manager';
import {
  computeNextFireAt,
  getAutomationRunner,
  getAutomationScheduler,
  getAutomationStore,
} from '../../automations';
import { getAutomationEvents } from '../../automations/automation-events';

function responseError(code: string, error: unknown): IpcResponse {
  return {
    success: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    },
  };
}

async function handlePastOneTimeCreate(automation: Automation): Promise<void> {
  if (automation.schedule.type !== 'oneTime' || automation.schedule.runAt > Date.now()) {
    return;
  }

  const store = getAutomationStore();
  const events = getAutomationEvents();
  if (automation.missedRunPolicy === 'runOnce') {
    await getAutomationRunner().fire(automation.id, {
      trigger: 'catchUp',
      scheduledAt: automation.schedule.runAt,
    });
    return;
  }

  const reason = automation.missedRunPolicy === 'notify'
    ? 'One-time automation was already in the past when created'
    : 'Past one-time automation skipped by missed-run policy';
  const run = store.recordSkipped(automation, 'catchUp', automation.schedule.runAt, reason);
  store.completeOneTime(automation.id);
  const completed = await store.get(automation.id);
  events.emitRunChanged({ automationId: automation.id, run });
  events.emitRunTerminal({ automationId: automation.id, runId: run.id, status: 'skipped' });
  events.emitChanged({ automation: completed, automationId: automation.id, type: 'updated' });
  events.emitScheduleDeactivated({ automationId: automation.id });
}

export function registerAutomationHandlers(): void {
  const store = getAutomationStore();
  const runner = getAutomationRunner();
  const scheduler = getAutomationScheduler();
  const events = getAutomationEvents();

  ipcMain.handle(IPC_CHANNELS.AUTOMATION_LIST, async (): Promise<IpcResponse> => {
    try {
      return { success: true, data: await store.list() };
    } catch (error) {
      return responseError('AUTOMATION_LIST_FAILED', error);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.AUTOMATION_GET,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(AutomationGetPayloadSchema, payload, 'AUTOMATION_GET');
        return { success: true, data: await store.get(validated.id) };
      } catch (error) {
        return responseError('AUTOMATION_GET_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.AUTOMATION_CREATE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(AutomationCreatePayloadSchema, payload, 'AUTOMATION_CREATE');
        const now = Date.now();
        const missedRunPolicy =
          validated.missedRunPolicy ?? getSettingsManager().get('defaultMissedRunPolicy');
        const nextFireAt = validated.enabled === false
          ? null
          : computeNextFireAt(validated.schedule, now);
        const automation = await store.create({
          ...validated,
          missedRunPolicy,
          action: validated.action,
        }, nextFireAt, now);

        events.emitChanged({ automation, automationId: automation.id, type: 'created' });
        await handlePastOneTimeCreate(automation);
        return { success: true, data: await store.get(automation.id) };
      } catch (error) {
        return responseError('AUTOMATION_CREATE_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.AUTOMATION_UPDATE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(AutomationUpdatePayloadSchema, payload, 'AUTOMATION_UPDATE');
        const existing = await store.get(validated.id);
        if (!existing) {
          return { success: false, error: { code: 'AUTOMATION_NOT_FOUND', message: 'Automation not found', timestamp: Date.now() } };
        }
        const schedule = validated.updates.schedule ?? existing.schedule;
        const enabled = validated.updates.enabled ?? existing.enabled;
        const active = validated.updates.active ?? existing.active;
        const nextFireAt = enabled && active ? computeNextFireAt(schedule, Date.now()) : null;
        const automation = await store.update(validated.id, validated.updates, nextFireAt);
        scheduler.schedule(automation);
        events.emitChanged({ automation, automationId: automation.id, type: 'updated' });
        await handlePastOneTimeCreate(automation);
        return { success: true, data: await store.get(automation.id) };
      } catch (error) {
        return responseError('AUTOMATION_UPDATE_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.AUTOMATION_DELETE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(AutomationDeletePayloadSchema, payload, 'AUTOMATION_DELETE');
        const { runningInstanceIds } = await store.delete(validated.id);
        runner.untrackInstances(runningInstanceIds);
        scheduler.deactivate(validated.id);
        events.emitChanged({ automation: null, automationId: validated.id, type: 'deleted' });
        return { success: true, data: { deleted: true } };
      } catch (error) {
        return responseError('AUTOMATION_DELETE_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.AUTOMATION_RUN_NOW,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(AutomationRunNowPayloadSchema, payload, 'AUTOMATION_RUN_NOW');
        return {
          success: true,
          data: await runner.fire(validated.id, {
            trigger: 'manual',
            idempotencyKey: validated.idempotencyKey,
            triggerSource: validated.triggerSource,
            deliveryMode: validated.deliveryMode,
          }),
        };
      } catch (error) {
        return responseError('AUTOMATION_RUN_NOW_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.AUTOMATION_CANCEL_PENDING,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(AutomationCancelPendingPayloadSchema, payload, 'AUTOMATION_CANCEL_PENDING');
        const runs = store.cancelPending(validated.id);
        for (const run of runs) {
          events.emitRunChanged({ automationId: validated.id, run });
        }
        return { success: true, data: runs };
      } catch (error) {
        return responseError('AUTOMATION_CANCEL_PENDING_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.AUTOMATION_LIST_RUNS,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(AutomationListRunsPayloadSchema, payload ?? {}, 'AUTOMATION_LIST_RUNS');
        return { success: true, data: store.listRuns(validated) };
      } catch (error) {
        return responseError('AUTOMATION_LIST_RUNS_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.AUTOMATION_MARK_SEEN,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(AutomationMarkSeenPayloadSchema, payload, 'AUTOMATION_MARK_SEEN');
        store.markSeen(validated);
        return { success: true };
      } catch (error) {
        return responseError('AUTOMATION_MARK_SEEN_FAILED', error);
      }
    },
  );
}
