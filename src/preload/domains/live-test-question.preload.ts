import type { IpcRenderer } from 'electron';
import type { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

/**
 * Live-test app only. A normal app registers no handlers for these channels, so
 * both calls fail there; the live-test copy's runbook explains their use.
 */
export function createLiveTestQuestionDomain(
  ipc: IpcRenderer,
  ch: typeof IPC_CHANNELS,
  withAuth: (payload?: Record<string, unknown>) => Record<string, unknown> & { ipcAuthToken?: string },
) {
  return {
    /**
     * Start a disposable session that raises a real question card. Its prompt picks the
     * card: "free-text" asks a free-text question, "permission" raises a permission card,
     * anything else asks an exact-choice question.
     */
    createLiveTestQuestionSession: (): Promise<IpcResponse> =>
      ipc.invoke(ch.LIVE_TEST_QUESTION_SESSION_CREATE, withAuth({})),
    /** Remove a session createLiveTestQuestionSession started; refuses any other. */
    removeLiveTestQuestionSession: (payload: { instanceId: string }): Promise<IpcResponse> =>
      ipc.invoke(ch.LIVE_TEST_QUESTION_SESSION_REMOVE, withAuth(payload)),
  };
}
