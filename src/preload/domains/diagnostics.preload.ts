import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type {
  CliUpdatePillState,
  OperatorArtifactExportRequest,
} from '../../shared/types/diagnostics.types';
import type { IpcResponse } from './types';

export function createDiagnosticsDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    diagnosticsGetDoctorReport: (payload?: {
      workingDirectory?: string;
      force?: boolean;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.DIAGNOSTICS_GET_DOCTOR_REPORT, payload ?? {}),

    diagnosticsGetSkillDiagnostics: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.DIAGNOSTICS_GET_SKILL_DIAGNOSTICS, {}),

    diagnosticsGetInstructionDiagnostics: (payload?: {
      workingDirectory?: string;
      broadRootFileThreshold?: number;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.DIAGNOSTICS_GET_INSTRUCTION_DIAGNOSTICS, payload ?? {}),

    diagnosticsExportArtifactBundle: (payload?: OperatorArtifactExportRequest): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.DIAGNOSTICS_EXPORT_ARTIFACT_BUNDLE, payload ?? {}),

    diagnosticsRevealBundle: (payload: { bundlePath: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.DIAGNOSTICS_REVEAL_BUNDLE, payload),

    cliUpdatePillGetState: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CLI_UPDATE_PILL_GET_STATE, {}),

    cliUpdatePillRefresh: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CLI_UPDATE_PILL_REFRESH, {}),

    onCliUpdatePillDelta: (callback: (state: CliUpdatePillState) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, state: CliUpdatePillState) => callback(state);
      ipcRenderer.on(ch.CLI_UPDATE_PILL_DELTA, listener);
      return () => ipcRenderer.removeListener(ch.CLI_UPDATE_PILL_DELTA, listener);
    },
  };
}
