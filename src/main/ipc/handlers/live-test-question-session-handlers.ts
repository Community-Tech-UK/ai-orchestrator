/**
 * Live-test app only: a disposable session that raises a real question card.
 *
 * The handlers exist only when Harness was started as a live-test copy (its own
 * profile and ownership receipt, see live-test-context.ts); a normal app never
 * registers them. A session is made in a folder this module creates inside the
 * test profile, and only a session made here can be removed here.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import {
  LiveTestQuestionSessionCreatePayloadSchema,
  LiveTestQuestionSessionRemovePayloadSchema,
} from '@contracts/schemas/instance';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { harnessLiveTestDataPath, isHarnessLiveTest } from '../../app/live-test-context';
import {
  claimLiveTestQuestionFolder,
  MAX_LIVE_TEST_QUESTION_SESSIONS,
  releaseLiveTestQuestionFolder,
} from '../../cli/adapters/live-test-question-fixtures';
import type { InstanceManager } from '../../instance/instance-manager';
import { validatedHandler } from '../validated-handler';

/** Session id to its folder, for sessions made here and not yet removed. */
const owned = new Map<string, string>();

function liveTestDataPath(): string {
  const dataPath = harnessLiveTestDataPath();
  if (!dataPath) throw new Error('Live-test question sessions are only available in a live-test copy of Harness.');
  return dataPath;
}

export function registerLiveTestQuestionSessionHandlers(deps: {
  instanceManager: InstanceManager;
  ensureTrustedSender?: (event: IpcMainInvokeEvent, channel: string) => IpcResponse | null;
}): void {
  if (!isHarnessLiveTest()) return;
  const { instanceManager, ensureTrustedSender } = deps;

  ipcMain.handle(
    IPC_CHANNELS.LIVE_TEST_QUESTION_SESSION_CREATE,
    validatedHandler(
      IPC_CHANNELS.LIVE_TEST_QUESTION_SESSION_CREATE,
      LiveTestQuestionSessionCreatePayloadSchema,
      async () => {
        const folder = await mkdtemp(join(liveTestDataPath(), 'question-session-'));
        if (!claimLiveTestQuestionFolder(folder)) {
          await rm(folder, { recursive: true, force: true });
          throw new Error(`At most ${MAX_LIVE_TEST_QUESTION_SESSIONS} live-test question sessions may exist at once. Remove one first.`);
        }
        try {
          const instance = await instanceManager.createInstance({
            workingDirectory: folder,
            provider: 'opencode',
            // YOLO would answer the permission card for the session.
            yoloMode: false,
            displayName: 'Live-test question session',
          });
          owned.set(instance.id, folder);
          return { success: true, data: { instanceId: instance.id } };
        } catch (error) {
          releaseLiveTestQuestionFolder(folder);
          await rm(folder, { recursive: true, force: true });
          throw error;
        }
      },
      { ensureTrustedSender, errorCode: 'LIVE_TEST_QUESTION_SESSION_CREATE_FAILED' },
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.LIVE_TEST_QUESTION_SESSION_REMOVE,
    validatedHandler(
      IPC_CHANNELS.LIVE_TEST_QUESTION_SESSION_REMOVE,
      LiveTestQuestionSessionRemovePayloadSchema,
      async ({ instanceId }) => {
        const folder = owned.get(instanceId);
        if (!folder) {
          return {
            success: false,
            error: {
              code: 'NOT_A_LIVE_TEST_QUESTION_SESSION',
              message: 'Only a session started by createLiveTestQuestionSession can be removed here.',
              timestamp: Date.now(),
            },
          };
        }
        try {
          // Already closed some other way: nothing to stop, but its folder is still ours to clean up.
          if (instanceManager.getInstance(instanceId)) await instanceManager.terminateInstance(instanceId, false);
        } finally {
          owned.delete(instanceId);
          releaseLiveTestQuestionFolder(folder);
          await rm(folder, { recursive: true, force: true });
        }
        return { success: true };
      },
      { ensureTrustedSender, errorCode: 'LIVE_TEST_QUESTION_SESSION_REMOVE_FAILED' },
    ),
  );
}

export function _resetLiveTestQuestionSessionsForTesting(): void {
  owned.clear();
}
