/**
 * IPC surface for skill observability: recent activations, health summary,
 * per-skill controls (kill-switch), and the live activation delta push.
 *
 * Spec: 2026-07-23-skill-observability-and-design-skills_spec_planned.md §3.2
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import {
  SkillsActivationsRecentPayloadSchema,
  SkillsHealthSummaryPayloadSchema,
  SkillsSetControlPayloadSchema,
} from '@contracts/schemas/provider';
import type { WindowManager } from '../../window-manager';
import {
  getSkillAttribution,
  type SkillAttributionService,
  type SkillActivation,
} from '../../skills/skill-attribution-service';
import { registerCleanup } from '../../util/cleanup-registry';
import { validatedHandler, type IpcResponse } from '../validated-handler';

interface SkillAttributionHandlerDependencies {
  windowManager: WindowManager;
  attributionService?: SkillAttributionService;
  /**
   * EventEmitter-compatible source of `instance:state-changed` events
   * (the InstanceManager in production). Used for the error-correlation flag.
   */
  instanceEvents?: {
    on(event: string, listener: (payload: unknown) => void): unknown;
    off(event: string, listener: (payload: unknown) => void): unknown;
  };
}

/** Statuses that count as "the instance hit an error" for correlation. */
const ERROR_STATUSES = new Set(['failed', 'error']);

let activeCleanup: (() => void) | null = null;

export function registerSkillAttributionHandlers(
  dependencies: SkillAttributionHandlerDependencies,
): () => void {
  activeCleanup?.();
  const attribution = dependencies.attributionService ?? getSkillAttribution();

  let acceptingDeltas = true;
  const onActivation = (activation: SkillActivation) => {
    if (!acceptingDeltas) return;
    dependencies.windowManager.sendToRenderer(IPC_CHANNELS.SKILLS_ACTIVATION_DELTA, activation);
  };
  attribution.on('activation', onActivation);

  const onInstanceStateChanged = (payload: unknown) => {
    const event = payload as { instanceId?: string; status?: string; timestamp?: number };
    if (!event?.instanceId || !event.status || !ERROR_STATUSES.has(event.status)) return;
    attribution.markErrorForInstance(event.instanceId, undefined, event.timestamp ?? Date.now());
  };
  dependencies.instanceEvents?.on('instance:state-changed', onInstanceStateChanged);

  ipcMain.handle(
    IPC_CHANNELS.SKILLS_ACTIVATIONS_RECENT,
    validatedHandler(
      IPC_CHANNELS.SKILLS_ACTIVATIONS_RECENT,
      SkillsActivationsRecentPayloadSchema,
      async (query): Promise<IpcResponse> => ({
        success: true,
        data: attribution.getRecentActivations(query ?? {}),
      }),
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILLS_HEALTH_SUMMARY,
    validatedHandler(
      IPC_CHANNELS.SKILLS_HEALTH_SUMMARY,
      SkillsHealthSummaryPayloadSchema,
      async (payload): Promise<IpcResponse> => ({
        success: true,
        data: {
          summary: attribution.getHealthSummary(payload?.since),
          controls: attribution.listControls(),
        },
      }),
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILLS_LIST_CONTROLS,
    async (): Promise<IpcResponse> => ({ success: true, data: attribution.listControls() }),
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILLS_SET_CONTROL,
    validatedHandler(
      IPC_CHANNELS.SKILLS_SET_CONTROL,
      SkillsSetControlPayloadSchema,
      async (payload): Promise<IpcResponse> => {
        const control = attribution.setControl(payload.skillName, payload.mode, payload.reason);
        if (!control) {
          return {
            success: false,
            error: {
              code: 'SKILLS_SET_CONTROL_FAILED',
              message: `Could not persist control for skill: ${payload.skillName}`,
              timestamp: Date.now(),
            },
          };
        }
        return { success: true, data: control };
      },
    ),
  );

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    acceptingDeltas = false;
    if (activeCleanup === cleanup) activeCleanup = null;
    attribution.off('activation', onActivation);
    dependencies.instanceEvents?.off('instance:state-changed', onInstanceStateChanged);
    ipcMain.removeHandler(IPC_CHANNELS.SKILLS_ACTIVATIONS_RECENT);
    ipcMain.removeHandler(IPC_CHANNELS.SKILLS_HEALTH_SUMMARY);
    ipcMain.removeHandler(IPC_CHANNELS.SKILLS_LIST_CONTROLS);
    ipcMain.removeHandler(IPC_CHANNELS.SKILLS_SET_CONTROL);
  };
  activeCleanup = cleanup;
  registerCleanup(cleanup);
  return cleanup;
}
