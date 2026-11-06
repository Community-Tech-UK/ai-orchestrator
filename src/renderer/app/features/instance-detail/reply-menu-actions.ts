import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { CouncilPrefillService } from '../compare/council-prefill.service';
import { IpcFacadeService } from '../../core/services/ipc';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';
import { InstanceStore } from '../../core/state/instance/instance.store';

/**
 * The reply menu's actions that are not the transcript's own UI state: opening
 * Ask Council with a prepared prompt, asking for a second opinion, and forking
 * the session at a message. They live here so the transcript component stays
 * inside its file-size ratchet (check:ts-max-loc).
 */
@Injectable({ providedIn: 'root' })
export class ReplyMenuActions {
  private readonly router = inject(Router);
  private readonly councilPrefill = inject(CouncilPrefillService);
  private readonly reviewIpc = inject(CrossModelReviewIpcService);
  private readonly ipc = inject(IpcFacadeService);
  private readonly instanceStore = inject(InstanceStore);

  /** Fill Council with a comparison prompt and open the page. Never starts a run. */
  openAskCouncil(context: string): void {
    this.councilPrefill.set(context);
    void this.router.navigate(['/ask-council']);
  }

  requestReview(instanceId: string): void {
    void this.reviewIpc.requestReview(instanceId);
  }

  /** Fork the session right after a message; a missing id or index means no-op. */
  async forkFromMessage(instanceId: string | undefined, bufferIndex: number | undefined): Promise<void> {
    if (!instanceId || bufferIndex === undefined) return;
    const result = await this.ipc.forkSession(instanceId, bufferIndex + 1, `Fork at message ${bufferIndex + 1}`);
    if (result?.success && result.data) {
      const data = result.data as { id?: string };
      if (data.id) {
        this.instanceStore.setSelectedInstance(data.id);
      }
    }
  }
}
