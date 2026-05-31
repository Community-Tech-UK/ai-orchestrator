/**
 * Magic Prompt IPC Handlers
 *
 * Exposes the schema-backed one-shot "magic prompt" commands to the renderer:
 *  - magic-prompt:list — enumerate available prompts (id/title/description)
 *  - magic-prompt:run  — run a prompt and return a validated structured result
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import { MagicPromptRunPayloadSchema } from '@contracts/schemas/command';
import { getMagicPromptService } from '../../magic-prompts/magic-prompt-service';

export function registerMagicPromptHandlers(): void {
  const service = getMagicPromptService();

  ipcMain.handle(
    IPC_CHANNELS.MAGIC_PROMPT_LIST,
    async (): Promise<IpcResponse> => {
      try {
        return { success: true, data: service.list() };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MAGIC_PROMPT_LIST_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAGIC_PROMPT_RUN,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(MagicPromptRunPayloadSchema, payload, 'MAGIC_PROMPT_RUN');
        const result = await service.run({
          id: validated.id,
          text: validated.text,
          context: validated.context,
          provider: validated.provider,
          workingDirectory: validated.workingDirectory,
        });
        // The run result carries its own ok/error discriminator; always return a
        // transport-level success so the renderer can inspect result.ok.
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MAGIC_PROMPT_RUN_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
