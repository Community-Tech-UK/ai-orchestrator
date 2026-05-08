import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

interface LoopConfigInput {
  initialPrompt: string;
  workspaceCwd: string;
  planFile?: string;
  provider?: 'claude' | 'codex';
  reviewStyle?: 'single' | 'debate' | 'star-chamber';
  contextStrategy?: 'fresh-child' | 'hybrid' | 'same-session';
  caps?: Partial<{
    maxIterations: number;
    maxWallTimeMs: number;
    maxTokens: number;
    maxCostCents: number;
    maxToolCallsPerIteration: number;
  }>;
  completion?: Partial<{
    completedFilenamePattern: string;
    donePromiseRegex: string;
    doneSentinelFile: string;
    verifyCommand: string;
    verifyTimeoutMs: number;
    runVerifyTwice: boolean;
    requireCompletedFileRename: boolean;
  }>;
  initialStage?: 'PLAN' | 'REVIEW' | 'IMPLEMENT';
  allowDestructiveOps?: boolean;
}

export function createLoopDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  const sub = (channel: string) => (callback: (payload: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };

  return {
    loopStart: (chatId: string, config: LoopConfigInput): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.LOOP_START, { chatId, config }),
    loopPause: (loopRunId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.LOOP_PAUSE, { loopRunId }),
    loopResume: (loopRunId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.LOOP_RESUME, { loopRunId }),
    loopIntervene: (loopRunId: string, message: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.LOOP_INTERVENE, { loopRunId, message }),
    loopCancel: (loopRunId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.LOOP_CANCEL, { loopRunId }),
    loopGetState: (loopRunId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.LOOP_GET_STATE, { loopRunId }),
    loopListRunsForChat: (chatId: string, limit?: number): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.LOOP_LIST_RUNS_FOR_CHAT, { chatId, limit }),
    loopGetIterations: (loopRunId: string, fromSeq?: number, toSeq?: number): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.LOOP_GET_ITERATIONS, { loopRunId, fromSeq, toSeq }),

    onLoopStateChanged: sub(ch.LOOP_STATE_CHANGED),
    onLoopStarted: sub(ch.LOOP_STARTED),
    onLoopIterationStarted: sub(ch.LOOP_ITERATION_STARTED),
    onLoopIterationComplete: sub(ch.LOOP_ITERATION_COMPLETE),
    onLoopPausedNoProgress: sub(ch.LOOP_PAUSED_NO_PROGRESS),
    onLoopClaimedDoneButFailed: sub(ch.LOOP_CLAIMED_DONE_BUT_FAILED),
    onLoopInterventionApplied: sub(ch.LOOP_INTERVENTION_APPLIED),
    onLoopCompleted: sub(ch.LOOP_COMPLETED),
    onLoopCapReached: sub(ch.LOOP_CAP_REACHED),
    onLoopCancelled: sub(ch.LOOP_CANCELLED),
    onLoopError: sub(ch.LOOP_ERROR),
  };
}
