import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export interface LoopConfigInput {
  initialPrompt: string;
  /** Optional continuation directive used on iterations 1+. If omitted,
   *  the runtime re-uses `initialPrompt` for every iteration. */
  iterationPrompt?: string;
  workspaceCwd: string;
  planFile?: string;
  provider?: 'claude' | 'codex';
  reviewStyle?: 'single' | 'debate' | 'star-chamber';
  contextStrategy?: 'fresh-child' | 'hybrid' | 'same-session';
  caps?: Partial<{
    maxIterations: number;
    maxWallTimeMs: number;
    maxTokens: number;
    maxCostCents: number | null;
    maxToolCallsPerIteration: number;
  }>;
  completion?: Partial<{
    completedFilenamePattern: string;
    donePromiseRegex: string;
    doneSentinelFile: string;
    verifyCommand: string;
    allowOperatorReviewedCompletion: boolean;
    verifyTimeoutMs: number;
    runVerifyTwice: boolean;
    requireCompletedFileRename: boolean;
  }>;
  initialStage?: 'PLAN' | 'REVIEW' | 'IMPLEMENT';
  allowDestructiveOps?: boolean;
  /** Wall-clock cap per iteration (ms). */
  iterationTimeoutMs?: number;
  /** Stream-idle threshold per iteration (ms). */
  streamIdleTimeoutMs?: number;
  /** LF-1: context discipline block. */
  context?: {
    compaction: { enabled: boolean; resetAtUtilization: number; clearToolResults: boolean };
  };
  /** LF-4: disposable-plan behaviour. */
  plan?: { regenerateOnStall: boolean };
}

export function createLoopDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  const sub = (channel: string) => (callback: (payload: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };

  return {
    loopStart: (
      chatId: string,
      config: LoopConfigInput,
      attachments?: { name: string; data: Uint8Array }[],
    ): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.LOOP_START, { chatId, config, attachments }),
    loopPause: (loopRunId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.LOOP_PAUSE, { loopRunId }),
    loopResume: (loopRunId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.LOOP_RESUME, { loopRunId }),
    loopIntervene: (loopRunId: string, message: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.LOOP_INTERVENE, { loopRunId, message }),
    loopCancel: (loopRunId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.LOOP_CANCEL, { loopRunId }),
    loopAcceptCompletion: (loopRunId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.LOOP_ACCEPT_COMPLETION, { loopRunId }),
    loopGetState: (loopRunId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.LOOP_GET_STATE, { loopRunId }),
    loopListRunsForChat: (chatId: string, limit?: number): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.LOOP_LIST_RUNS_FOR_CHAT, { chatId, limit }),
    loopGetIterations: (loopRunId: string, fromSeq?: number, toSeq?: number): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.LOOP_GET_ITERATIONS, { loopRunId, fromSeq, toSeq }),
    loopInferVerify: (workspaceCwd: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.LOOP_INFER_VERIFY, { workspaceCwd }),

    onLoopStateChanged: sub(ch.LOOP_STATE_CHANGED),
    onLoopStarted: sub(ch.LOOP_STARTED),
    onLoopIterationStarted: sub(ch.LOOP_ITERATION_STARTED),
    onLoopActivity: sub(ch.LOOP_ACTIVITY),
    onLoopIterationComplete: sub(ch.LOOP_ITERATION_COMPLETE),
    onLoopPausedNoProgress: sub(ch.LOOP_PAUSED_NO_PROGRESS),
    onLoopClaimedDoneButFailed: sub(ch.LOOP_CLAIMED_DONE_BUT_FAILED),
    onLoopTerminalIntentRecorded: sub(ch.LOOP_TERMINAL_INTENT_RECORDED),
    onLoopTerminalIntentRejected: sub(ch.LOOP_TERMINAL_INTENT_REJECTED),
    onLoopFreshEyesReviewStarted: sub(ch.LOOP_FRESH_EYES_REVIEW_STARTED),
    onLoopFreshEyesReviewPassed: sub(ch.LOOP_FRESH_EYES_REVIEW_PASSED),
    onLoopFreshEyesReviewFailed: sub(ch.LOOP_FRESH_EYES_REVIEW_FAILED),
    onLoopFreshEyesReviewBlocked: sub(ch.LOOP_FRESH_EYES_REVIEW_BLOCKED),
    onLoopInterventionApplied: sub(ch.LOOP_INTERVENTION_APPLIED),
    onLoopCompleted: sub(ch.LOOP_COMPLETED),
    onLoopCompletedNeedsReview: sub(ch.LOOP_COMPLETED_NEEDS_REVIEW),
    onLoopNotesCurated: sub(ch.LOOP_NOTES_CURATED),
    onLoopFailed: sub(ch.LOOP_FAILED),
    onLoopCapReached: sub(ch.LOOP_CAP_REACHED),
    onLoopCancelled: sub(ch.LOOP_CANCELLED),
    onLoopError: sub(ch.LOOP_ERROR),
  };
}
