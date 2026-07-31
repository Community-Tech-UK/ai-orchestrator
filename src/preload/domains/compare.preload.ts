/**
 * Compare domain — multi-provider "Ask Council" (backlog #11) + WS-B6
 * progressive Council run with synthesis.
 *
 *   compareListProviders / compareRun         — legacy synchronous fan-out
 *   compareStart / compareCancel /
 *   compareSynthesize / compareGetRun /
 *   onCompareRunUpdated                       — WS-B6 progressive run
 *
 * Split out of infrastructure.preload.ts to keep that file under the
 * TypeScript file-size ratchet (see scripts/check-ts-max-loc.ts).
 */

import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';
import type { CouncilRun, CouncilSynthesisMethod } from '@contracts/schemas/command';

export function createCompareDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    compareListProviders: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.COMPARE_LIST_PROVIDERS);
    },
    compareRun: (payload: {
      prompt: string;
      providers: string[];
      workingDirectory?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.COMPARE_RUN, payload);
    },

    // WS-B6: progressive Council run with synthesis
    compareStart: (payload: {
      prompt: string;
      providers: string[];
      workingDirectory?: string;
    }): Promise<IpcResponse<CouncilRun>> => {
      return ipcRenderer.invoke(ch.COMPARE_START, payload);
    },
    compareCancel: (runId: string): Promise<IpcResponse<CouncilRun>> => {
      return ipcRenderer.invoke(ch.COMPARE_CANCEL, { runId });
    },
    compareSynthesize: (payload: {
      runId: string;
      method: CouncilSynthesisMethod;
    }): Promise<IpcResponse<CouncilRun>> => {
      return ipcRenderer.invoke(ch.COMPARE_SYNTHESIZE, payload);
    },
    compareGetRun: (runId?: string): Promise<IpcResponse<CouncilRun | null>> => {
      return ipcRenderer.invoke(ch.COMPARE_GET_RUN, { runId });
    },
    onCompareRunUpdated: (callback: (run: CouncilRun) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, run: CouncilRun) => callback(run);
      ipcRenderer.on(ch.COMPARE_RUN_UPDATED, handler);
      return () => ipcRenderer.removeListener(ch.COMPARE_RUN_UPDATED, handler);
    },
  };
}
