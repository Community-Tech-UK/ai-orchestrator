import { Injectable, inject } from '@angular/core';
import type {
  LoopRunSummaryPayload,
  LoopStatePayload,
  LoopIterationPayload,
  LoopTerminalIntentPayload,
} from '@contracts/schemas/loop';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';

export interface LoopActivityPayload {
  loopRunId: string;
  seq: number;
  stage: string;
  kind: 'spawned' | 'status' | 'tool_use' | 'assistant' | 'system' | 'input_required' | 'error' | 'stream-idle' | 'complete' | 'heartbeat';
  message: string;
  timestamp: number;
  detail?: Record<string, unknown>;
}

export interface LoopControlResult {
  ok: boolean;
  state?: LoopStatePayload | null;
}

export interface LoopStartConfigInput {
  initialPrompt: string;
  /** Optional continuation directive used on iterations 1+. If omitted,
   *  the runtime re-uses `initialPrompt` for every iteration. */
  iterationPrompt?: string;
  workspaceCwd: string;
  planFile?: string;
  provider?: 'claude' | 'codex' | 'gemini' | 'copilot' | 'cursor';
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
    mode: 'review-driven' | 'gated';
    requiredCleanReviewPasses: number;
    noOutstandingPhrase: string;
    completedFilenamePattern: string;
    donePromiseRegex: string;
    doneSentinelFile: string;
    verifyCommand: string;
    quickVerifyCommand: string;
    quickVerifyTimeoutMs: number;
    allowOperatorReviewedCompletion: boolean;
    verifyTimeoutMs: number;
    runVerifyTwice: boolean;
    requireCompletedFileRename: boolean;
    crossModelReview: {
      enabled: boolean;
      reviewers?: string[];
      blockingSeverities: ('critical' | 'high' | 'medium' | 'low')[];
      timeoutSeconds: number;
      reviewDepth: 'structured' | 'tiered';
    };
  }>;
  /**
   * Progress-detector thresholds. Optional; if omitted, the main process
   * applies the canonical defaults from `defaultLoopConfig()`. When set,
   * Zod requires the full strict shape (matching `LoopProgressThresholds`)
   * so the renderer should spread the canonical defaults and override only
   * what it actually changes.
   */
  progressThresholds?: {
    identicalHashWarnConsecutive: number;
    identicalHashCriticalConsecutive: number;
    identicalHashCriticalWindow: number;
    similarityWarnMean: number;
    similarityCriticalMean: number;
    stageWarnIterations: { PLAN: number; REVIEW: number; IMPLEMENT: number };
    stageCriticalIterations: { PLAN: number; REVIEW: number; IMPLEMENT: number };
    errorRepeatWarnInWindow: number;
    errorRepeatCriticalInWindow: number;
    tokensWithoutProgressWarn: number;
    tokensWithoutProgressCritical: number;
    pauseOnTokenBurn: boolean;
    toolRepeatWarnPerIteration: number;
    toolRepeatCriticalPerIteration: number;
    testStagnationWarnIterations: number;
    testStagnationCriticalIterations: number;
    churnRatioWarn: number;
    churnRatioCritical: number;
    warnEscalationWindow: number;
    warnEscalationCount: number;
  };
  semanticProgress?: {
    enabled: boolean;
    cadence: number;
    confidenceFloor: number;
  };
  exploration?: {
    enabled: boolean;
    fanout: number;
    crossModel: boolean;
    selector: 'verify' | 'verify+listwise';
  };
  initialStage?: 'PLAN' | 'REVIEW' | 'IMPLEMENT';
  allowDestructiveOps?: boolean;
  /** Wall-clock cap per iteration (ms). */
  iterationTimeoutMs?: number;
  /** Stream-idle threshold per iteration (ms). */
  streamIdleTimeoutMs?: number;
  /** LF-1: context discipline (recycle the same-session adapter on long runs). */
  context?: {
    compaction: { enabled: boolean; resetAtUtilization: number; clearToolResults: boolean };
  };
  /** LF-4: disposable-plan behaviour (regenerate the plan on stall). */
  plan?: { regenerateOnStall: boolean };
}

@Injectable({ providedIn: 'root' })
export class LoopIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  private get ngZone() {
    return this.base.getNgZone();
  }

  async start(
    chatId: string,
    config: LoopStartConfigInput,
    attachments?: { name: string; data: Uint8Array }[],
  ): Promise<IpcResponse<{ state: LoopStatePayload }>> {
    const api = this.api;
    if (!api) return notInElectron();
    if (typeof api.loopStart !== 'function') {
      return {
        success: false,
        error: {
          message: 'Loop IPC bridge is unavailable. Reload the app and try again.',
        },
      };
    }
    return api.loopStart(chatId, config, attachments) as Promise<IpcResponse<{ state: LoopStatePayload }>>;
  }

  async pause(loopRunId: string): Promise<IpcResponse<LoopControlResult>> {
    if (!this.api) return notInElectron();
    return this.api.loopPause(loopRunId) as Promise<IpcResponse<LoopControlResult>>;
  }

  async resume(loopRunId: string): Promise<IpcResponse<LoopControlResult>> {
    if (!this.api) return notInElectron();
    return this.api.loopResume(loopRunId) as Promise<IpcResponse<LoopControlResult>>;
  }

  async intervene(loopRunId: string, message: string): Promise<IpcResponse<LoopControlResult>> {
    if (!this.api) return notInElectron();
    return this.api.loopIntervene(loopRunId, message) as Promise<IpcResponse<LoopControlResult>>;
  }

  async cancel(loopRunId: string): Promise<IpcResponse<LoopControlResult>> {
    if (!this.api) return notInElectron();
    return this.api.loopCancel(loopRunId) as Promise<IpcResponse<LoopControlResult>>;
  }

  /** LF-7: operator accepts a paused, done-but-ungated run. */
  async acceptCompletion(loopRunId: string): Promise<IpcResponse<LoopControlResult>> {
    if (!this.api) return notInElectron();
    const fn = (this.api as unknown as {
      loopAcceptCompletion?: (id: string) => Promise<IpcResponse<LoopControlResult>>;
    }).loopAcceptCompletion;
    if (typeof fn !== 'function') {
      return { success: false, error: { message: 'Accept-completion IPC bridge unavailable. Reload the app.' } };
    }
    return fn(loopRunId);
  }

  async getState(loopRunId: string): Promise<IpcResponse<{ state: LoopStatePayload | null; summary?: LoopRunSummaryPayload | null; source: 'live' | 'store' }>> {
    if (!this.api) return notInElectron();
    return this.api.loopGetState(loopRunId) as Promise<IpcResponse<{ state: LoopStatePayload | null; summary?: LoopRunSummaryPayload | null; source: 'live' | 'store' }>>;
  }

  async listRunsForChat(chatId: string, limit?: number): Promise<IpcResponse<{ runs: LoopRunSummaryPayload[] }>> {
    if (!this.api) return notInElectron();
    return this.api.loopListRunsForChat(chatId, limit) as Promise<IpcResponse<{ runs: LoopRunSummaryPayload[] }>>;
  }

  async getIterations(loopRunId: string, fromSeq?: number, toSeq?: number): Promise<IpcResponse<{ iterations: LoopIterationPayload[] }>> {
    if (!this.api) return notInElectron();
    return this.api.loopGetIterations(loopRunId, fromSeq, toSeq) as Promise<IpcResponse<{ iterations: LoopIterationPayload[] }>>;
  }

  /** LF-3a: preview the auto-inferred verify command for a workspace. */
  async inferVerify(workspaceCwd: string): Promise<IpcResponse<{ inferred: { command: string; source: string } | null }>> {
    if (!this.api) return notInElectron();
    const fn = (this.api as unknown as {
      loopInferVerify?: (cwd: string) => Promise<IpcResponse<{ inferred: { command: string; source: string } | null }>>;
    }).loopInferVerify;
    if (typeof fn !== 'function') {
      return { success: false, error: { message: 'infer-verify bridge unavailable' } };
    }
    return fn(workspaceCwd);
  }

  onStateChanged(cb: (data: { loopRunId: string; state: LoopStatePayload }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onLoopStateChanged((payload) => {
      this.ngZone.run(() => cb(payload as { loopRunId: string; state: LoopStatePayload }));
    });
  }
  onIterationStarted(cb: (data: { loopRunId: string; seq: number; stage: string }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onLoopIterationStarted((p) => this.ngZone.run(() => cb(p as { loopRunId: string; seq: number; stage: string })));
  }
  onActivity(cb: (data: LoopActivityPayload) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    const subscribe = (this.api as unknown as { onLoopActivity?: (cb: (p: unknown) => void) => () => void }).onLoopActivity;
    if (typeof subscribe !== 'function') return () => { /* noop */ };
    return subscribe((p) => this.ngZone.run(() => cb(p as LoopActivityPayload)));
  }
  onIterationComplete(cb: (data: { loopRunId: string; seq: number; verdict: string }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onLoopIterationComplete((p) => this.ngZone.run(() => cb(p as { loopRunId: string; seq: number; verdict: string })));
  }
  onPausedNoProgress(cb: (data: { loopRunId: string; signal: { id: string; message: string; verdict: string } }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onLoopPausedNoProgress((p) => this.ngZone.run(() => cb(p as { loopRunId: string; signal: { id: string; message: string; verdict: string } })));
  }
  onClaimedDoneButFailed(cb: (data: { loopRunId: string; signal: string; failure: string }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onLoopClaimedDoneButFailed((p) => this.ngZone.run(() => cb(p as { loopRunId: string; signal: string; failure: string })));
  }
  onTerminalIntentRecorded(cb: (data: { loopRunId: string; intent: LoopTerminalIntentPayload }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onLoopTerminalIntentRecorded((p) => this.ngZone.run(() => cb(p as { loopRunId: string; intent: LoopTerminalIntentPayload })));
  }
  onTerminalIntentRejected(cb: (data: { loopRunId: string; intent: LoopTerminalIntentPayload; reason: string }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onLoopTerminalIntentRejected((p) => this.ngZone.run(() => cb(p as { loopRunId: string; intent: LoopTerminalIntentPayload; reason: string })));
  }
  onFreshEyesReviewStarted(cb: (data: { loopRunId: string; signal: string }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onLoopFreshEyesReviewStarted((p) => this.ngZone.run(() => cb(p as { loopRunId: string; signal: string })));
  }
  onFreshEyesReviewPassed(cb: (data: { loopRunId: string; signal: string; reviewersUsed: string[]; nonBlockingFindings: number; summary?: string; infrastructureError?: string }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onLoopFreshEyesReviewPassed((p) => this.ngZone.run(() => cb(p as { loopRunId: string; signal: string; reviewersUsed: string[]; nonBlockingFindings: number; summary?: string; infrastructureError?: string })));
  }
  onFreshEyesReviewFailed(cb: (data: { loopRunId: string; signal: string; error: string }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onLoopFreshEyesReviewFailed((p) => this.ngZone.run(() => cb(p as { loopRunId: string; signal: string; error: string })));
  }
  onFreshEyesReviewBlocked(cb: (data: { loopRunId: string; signal: string; reviewersUsed: string[]; blockingFindings: unknown[]; summary?: string }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onLoopFreshEyesReviewBlocked((p) => this.ngZone.run(() => cb(p as { loopRunId: string; signal: string; reviewersUsed: string[]; blockingFindings: unknown[]; summary?: string })));
  }
  onCompleted(cb: (data: { loopRunId: string; signal: string; verifyOutput: string; acceptedByOperator?: boolean }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onLoopCompleted((p) => this.ngZone.run(() => cb(p as { loopRunId: string; signal: string; verifyOutput: string; acceptedByOperator?: boolean })));
  }
  /** LF-7: terminal "done, needs a human glance" event. */
  onCompletedNeedsReview(cb: (data: { loopRunId: string; reason: string; acceptedByOperator: boolean }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    const subscribe = (this.api as unknown as {
      onLoopCompletedNeedsReview?: (cb: (p: unknown) => void) => () => void;
    }).onLoopCompletedNeedsReview;
    if (typeof subscribe !== 'function') return () => { /* noop */ };
    return subscribe((p) => this.ngZone.run(() => cb(p as { loopRunId: string; reason: string; acceptedByOperator: boolean })));
  }
  onFailed(cb: (data: { loopRunId: string; reason: string }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onLoopFailed((p) => this.ngZone.run(() => cb(p as { loopRunId: string; reason: string })));
  }
  onCapReached(cb: (data: { loopRunId: string; cap: string }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onLoopCapReached((p) => this.ngZone.run(() => cb(p as { loopRunId: string; cap: string })));
  }
  onProviderLimit(
    cb: (data: {
      loopRunId: string;
      reason: string;
      source: 'quota' | 'notice';
      action: string;
      windowId?: string;
      resumeAt: number | null;
      willResume: boolean;
    }) => void,
  ): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onLoopProviderLimit((p) =>
      this.ngZone.run(() =>
        cb(
          p as {
            loopRunId: string;
            reason: string;
            source: 'quota' | 'notice';
            action: string;
            windowId?: string;
            resumeAt: number | null;
            willResume: boolean;
          },
        ),
      ),
    );
  }
  onCancelled(cb: (data: { loopRunId: string }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onLoopCancelled((p) => this.ngZone.run(() => cb(p as { loopRunId: string })));
  }
  onError(cb: (data: { loopRunId: string; error: string }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onLoopError((p) => this.ngZone.run(() => cb(p as { loopRunId: string; error: string })));
  }
}

function notInElectron<T>(): IpcResponse<T> {
  return { success: false, error: { message: 'Not in Electron' } };
}
