/**
 * IPC for the "what will this change cost?" sentence (Oct-2 T17).
 *
 * The renderer asks while a picker is open or a toggle is hovered, before anything is applied.
 * The reply is one plain sentence plus sizes, never conversation text.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '@contracts/channels';
import { InstanceIdSchema, RequiredModelIdSchema, validateIpcPayload } from '@contracts/schemas/common';
import { ModelRuntimeTargetSchema } from '@contracts/schemas/instance';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type { RuntimeChangePreview } from '../../../shared/types/runtime-change-preview.types';
import { getClaudeCacheLifetime } from '../../cli/adapters/claude-cache-lifetime';
import type { InstanceManager } from '../../instance/instance-manager';
import { previewRuntimeChange } from '../../instance/lifecycle/runtime-change-preview';

const PreviewPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  model: RequiredModelIdSchema.optional(),
  reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'workflow']).nullable().optional(),
  modelRuntimeTarget: ModelRuntimeTargetSchema.optional(),
  provider: z.enum(['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok', 'opencode']).optional(),
  /** The auto-approve setting the toggle would switch to. */
  yoloMode: z.boolean().optional(),
  /** The Claude or Codex account a session would move to. */
  accountProfileId: z.string().min(1).max(200).optional(),
  /** The Copilot account a session would move to. */
  copilotAccountProfileId: z.string().min(1).max(200).optional(),
});

export function registerRuntimeChangePreviewHandlers(instanceManager: InstanceManager): void {
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_RUNTIME_CHANGE_PREVIEW,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse<RuntimeChangePreview>> => {
      try {
        const { instanceId, ...request } = validateIpcPayload(PreviewPayloadSchema, payload, 'INSTANCE_RUNTIME_CHANGE_PREVIEW');
        const note = previewRuntimeChange({
          getInstance: (id) => instanceManager.getInstance(id),
          getAdapter: (id) => instanceManager.getAdapter(id),
          getCacheLifetimeMs: (id) => getClaudeCacheLifetime(instanceManager.getAdapter(id))?.lifetimeMs ?? null,
        }, instanceId, request);
        return { success: true, data: { note } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'RUNTIME_CHANGE_PREVIEW_FAILED',
            message: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
