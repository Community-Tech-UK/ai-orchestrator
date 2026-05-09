import { Injectable, inject } from '@angular/core';
import type {
  LoopRunSummaryPayload,
  LoopStatePayload,
  LoopIterationPayload,
} from '@contracts/schemas/loop';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';

export interface LoopActivityPayload {
  loopRunId: string;
  seq: number;
  stage: string;
  kind: 'spawned' | 'status' | 'tool_use' | 'assistant' | 'system' | 'error' | 'stream-idle' | 'complete' | 'heartbeat';
  message: string;
  timestamp: number;
  detail?: Record<string, unknown>;
}

export interface LoopStartConfigInput {
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
  /** Wall-clock cap per iteration (ms). */
  iterationTimeoutMs?: number;
  /** Stream-idle threshold per iteration (ms). */
  streamIdleTimeoutMs?: number;
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

  async pause(loopRunId: string): Promise<IpcResponse> {
    if (!this.api) return notInElectron();
    return this.api.loopPause(loopRunId);
  }

  async resume(loopRunId: string): Promise<IpcResponse> {
    if (!this.api) return notInElectron();
    return this.api.loopResume(loopRunId);
  }

  async intervene(loopRunId: string, message: string): Promise<IpcResponse> {
    if (!this.api) return notInElectron();
    return this.api.loopIntervene(loopRunId, message);
  }

  async cancel(loopRunId: string): Promise<IpcResponse> {
    if (!this.api) return notInElectron();
    return this.api.loopCancel(loopRunId);
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
  onCompleted(cb: (data: { loopRunId: string; signal: string; verifyOutput: string }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onLoopCompleted((p) => this.ngZone.run(() => cb(p as { loopRunId: string; signal: string; verifyOutput: string })));
  }
  onCapReached(cb: (data: { loopRunId: string; cap: string }) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onLoopCapReached((p) => this.ngZone.run(() => cb(p as { loopRunId: string; cap: string })));
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
