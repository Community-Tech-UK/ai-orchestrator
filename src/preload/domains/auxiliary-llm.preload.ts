import type { IpcRenderer } from 'electron';
import type { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createAuxiliaryLlmDomain(
  ipcRenderer: IpcRenderer,
  ch: typeof IPC_CHANNELS,
) {
  return {
    auxiliaryLlmListCandidates: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AUXILIARY_LLM_LIST_CANDIDATES),

    auxiliaryLlmProbeEndpoint: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AUXILIARY_LLM_PROBE_ENDPOINT, payload),

    auxiliaryLlmTestGenerate: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AUXILIARY_LLM_TEST_GENERATE, payload),

    auxiliaryLlmSaveSettings: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.AUXILIARY_LLM_SAVE_SETTINGS, payload),
  };
}
