import { Injectable, inject } from '@angular/core';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';
import { ElectronIpcService } from '../../core/services/ipc';
import { InstanceStore } from '../../core/state/instance.store';
import type { ChildDiagnosticBundle } from '../../../../shared/types/agent-tree.types';
import type {
  HudQuickAction,
  HudQuickActionResult,
} from '../../../../shared/types/orchestration-hud.types';
import { ChildDiagnosticBundleModalService } from './child-diagnostic-bundle.modal.service';

interface DiagnosticBundleResponse {
  ok: boolean;
  bundle?: ChildDiagnosticBundle;
  reason?: string;
}

interface SummarizeChildrenResponse {
  ok: boolean;
  reason?: string;
}

@Injectable({ providedIn: 'root' })
export class QuickActionDispatcherService {
  private instanceStore = inject(InstanceStore);
  private ipc = inject(ElectronIpcService);
  private modal = inject(ChildDiagnosticBundleModalService);
  private clipboard = inject(CLIPBOARD_SERVICE);

  async dispatch(action: HudQuickAction): Promise<HudQuickActionResult> {
    switch (action.kind) {
      case 'focus-child':
        this.instanceStore.setSelectedInstance(action.childInstanceId);
        return { ok: true };

      case 'copy-prompt-hash': {
        if (!action.spawnPromptHash) {
          return { ok: false, reason: 'No prompt hash on this child.' };
        }
        const result = await this.clipboard.copyText(action.spawnPromptHash, { label: 'prompt hash' });
        return result.ok
          ? { ok: true }
          : { ok: false, reason: `Clipboard write failed: ${result.reason}` };
      }

      case 'open-diagnostic-bundle': {
        const response = await this.ipc.invoke<DiagnosticBundleResponse>(
          'orchestration:get-child-diagnostic-bundle',
          { childInstanceId: action.childInstanceId },
        );
        if (response.success && response.data?.ok && response.data.bundle) {
          this.modal.open(response.data.bundle);
          return { ok: true };
        }
        return {
          ok: false,
          reason: response.error?.message ?? response.data?.reason ?? 'Failed to fetch diagnostic bundle.',
        };
      }

      case 'summarize-children': {
        const response = await this.ipc.invoke<SummarizeChildrenResponse>(
          'orchestration:summarize-children',
          { parentInstanceId: action.parentInstanceId },
        );
        return response.success && response.data?.ok !== false
          ? { ok: true }
          : { ok: false, reason: response.error?.message ?? response.data?.reason ?? 'Failed to summarize children.' };
      }
    }
  }
}
