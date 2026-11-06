/**
 * Asks the main process what a model, effort, provider or auto-approve change would cost
 * before it is made (Oct-2 T17). A failed or missing answer is just "nothing to say": the
 * preview must never get in the way of the change itself.
 */

import { Injectable, inject } from '@angular/core';
import type { ModelRuntimeTarget } from '../../../../../shared/types/local-model-runtime.types';
import type { ReasoningEffort } from '../../../../../shared/types/provider.types';
import type { RuntimeChangeCostNote } from '../../../../../shared/utils/runtime-change-cost';
import { ElectronIpcService } from './electron-ipc.service';

export interface RuntimeChangePreviewRequest {
  model?: string;
  reasoningEffort?: ReasoningEffort | null;
  modelRuntimeTarget?: ModelRuntimeTarget;
  provider?: 'claude' | 'codex' | 'gemini' | 'antigravity' | 'copilot' | 'cursor' | 'grok' | 'opencode';
  /** The auto-approve setting a toggle would switch to. */
  yoloMode?: boolean;
  /** The Claude or Codex account a session would move to. */
  accountProfileId?: string;
  /** The Copilot account a session would move to. */
  copilotAccountProfileId?: string;
}

@Injectable({ providedIn: 'root' })
export class RuntimeChangePreviewIpcService {
  private readonly base = inject(ElectronIpcService);

  async preview(instanceId: string, request: RuntimeChangePreviewRequest): Promise<RuntimeChangeCostNote | null> {
    const api = this.base.getApi();
    if (!api) return null;
    try {
      const response = await api.previewRuntimeChange({ instanceId, ...request });
      return response.success ? response.data?.note ?? null : null;
    } catch {
      return null;
    }
  }
}
