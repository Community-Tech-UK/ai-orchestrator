import { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { RuntimeChangePreview } from '../../shared/types/runtime-change-preview.types';
import type { ReasoningEffort } from '../../shared/types/provider.types';
import type { ModelRuntimeTarget } from '../../shared/types/local-model-runtime.types';
import type { IpcResponse } from './types';

export function createRuntimeChangePreviewDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    /** Ask what a model, effort, provider or auto-approve change would cost, before making it. */
    previewRuntimeChange: (payload: {
      instanceId: string;
      model?: string;
      reasoningEffort?: ReasoningEffort | null;
      modelRuntimeTarget?: ModelRuntimeTarget;
      provider?: 'claude' | 'codex' | 'gemini' | 'antigravity' | 'copilot' | 'cursor' | 'grok' | 'opencode';
      yoloMode?: boolean;
      accountProfileId?: string;
      copilotAccountProfileId?: string;
    }): Promise<IpcResponse<RuntimeChangePreview>> =>
      ipcRenderer.invoke(ch.INSTANCE_RUNTIME_CHANGE_PREVIEW, payload),
  };
}
