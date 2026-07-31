/**
 * Compare IPC Service — multi-provider "Ask Council" compare (backlog #11 / E4)
 * + WS-B6 progressive Council run with synthesis.
 *
 * Wraps the compare channels exposed by the infrastructure preload domain:
 *   compareListProviders  — which providers are currently installed
 *   compareRun            — fan out a prompt to N providers and await all answers
 *   compareStart          — start a progressive run (returns immediately, queued members)
 *   compareCancel         — cancel an in-flight run
 *   compareSynthesize     — synthesize completed answers (consensus/debate/chosen provider)
 *   compareGetRun         — fetch a run by id, or the latest run (rehydrate on init/reload)
 *   onCompareRunUpdated   — pushed after every member/synthesis state change
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';
import type { CouncilRun, CouncilSynthesisMethod } from '@contracts/schemas/command';

export type { CouncilRun, CouncilMember, CouncilMemberStatus, CouncilSynthesisMethod, CouncilSynthesisResult, CouncilSynthesisAttribution } from '@contracts/schemas/command';

@Injectable({ providedIn: 'root' })
export class CompareIpcService {
  private readonly base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  private get ngZone() {
    return this.base.getNgZone();
  }

  /** Return the list of currently-installed provider names. */
  async compareListProviders(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.compareListProviders();
  }

  /** Fan out `prompt` to `providers` and await all answers before returning. */
  async compareRun(payload: {
    prompt: string;
    providers: string[];
    workingDirectory?: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.compareRun(payload);
  }

  /** Start a progressive Council run — returns immediately with all members queued. */
  async compareStart(payload: {
    prompt: string;
    providers: string[];
    workingDirectory?: string;
  }): Promise<IpcResponse<CouncilRun>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.compareStart(payload);
  }

  /** Cancel an in-flight Council run. */
  async compareCancel(runId: string): Promise<IpcResponse<CouncilRun>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.compareCancel(runId);
  }

  /** Synthesize a run's completed answers via consensus, debate, or a chosen provider. */
  async compareSynthesize(payload: {
    runId: string;
    method: CouncilSynthesisMethod;
  }): Promise<IpcResponse<CouncilRun>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.compareSynthesize(payload);
  }

  /** Fetch a run by id, or (with no id) the most recently started run — for rehydrate on init. */
  async compareGetRun(runId?: string): Promise<IpcResponse<CouncilRun | null>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.compareGetRun(runId);
  }

  /** Subscribe to live run updates. Returns an unsubscribe function. */
  onCompareRunUpdated(callback: (run: CouncilRun) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onCompareRunUpdated((run) => this.ngZone.run(() => callback(run)));
  }
}
