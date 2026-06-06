/**
 * Auxiliary LLM IPC Service
 *
 * Provides renderer-side access to the auxiliary LLM handlers exposed by
 * the main process. Used by the Auxiliary Models settings tab and any future
 * surface that triggers local/cheap-model routing.
 */

import { Injectable, inject } from '@angular/core';
import type {
  AuxiliaryLlmCandidate,
  AuxiliaryLlmDecision,
  AuxiliaryLlmSlot,
} from '../../../../../shared/types/auxiliary-llm.types';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class AuxiliaryLlmIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  async listCandidates(): Promise<IpcResponse<AuxiliaryLlmCandidate[]>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.auxiliaryLlmListCandidates() as Promise<IpcResponse<AuxiliaryLlmCandidate[]>>;
  }

  async probeEndpoint(payload: {
    provider: string;
    baseUrl: string;
    apiKeyEnv?: string;
  }): Promise<IpcResponse<{ healthy: boolean }>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.auxiliaryLlmProbeEndpoint(payload) as Promise<IpcResponse<{ healthy: boolean }>>;
  }

  async testGenerate(payload: {
    slot: AuxiliaryLlmSlot;
    systemPrompt?: string;
    userPrompt?: string;
  }): Promise<IpcResponse<{ text: string; decision: AuxiliaryLlmDecision }>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.auxiliaryLlmTestGenerate(payload) as Promise<
      IpcResponse<{ text: string; decision: AuxiliaryLlmDecision }>
    >;
  }

  async saveSettings(payload: {
    auxiliaryLlmEnabled?: boolean;
    auxiliaryLlmRoutingMode?: string;
    auxiliaryLlmAllowRemoteWorkerModels?: boolean;
    auxiliaryLlmEndpointsJson?: string;
    auxiliaryLlmSlotsJson?: string;
  }): Promise<IpcResponse<{ ok: boolean }>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.auxiliaryLlmSaveSettings(payload) as Promise<IpcResponse<{ ok: boolean }>>;
  }
}
