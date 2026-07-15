import { Injectable, inject } from '@angular/core';
import type {
  DocReviewItemDecision,
  DocReviewOverall,
  DocReviewSession,
  DocReviewStatus,
} from '@contracts/schemas/doc-review';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';

/**
 * Renderer IPC wrapper for the doc-review pane: list/get pending reviews, read the
 * validated artifact HTML, submit James's decisions, dismiss, and open the artifact in
 * the external browser. Artifact bytes only ever arrive over readArtifact (the main
 * process re-validates the stored path each time).
 */
@Injectable({ providedIn: 'root' })
export class DocReviewIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  private get ngZone() {
    return this.base.getNgZone();
  }

  async list(payload: { status?: DocReviewStatus } = {}): Promise<IpcResponse<DocReviewSession[]>> {
    return this.call(() => this.api?.docReviewList(payload));
  }

  async get(reviewId: string): Promise<IpcResponse<DocReviewSession>> {
    return this.call(() => this.api?.docReviewGet({ reviewId }));
  }

  async readArtifact(reviewId: string): Promise<IpcResponse<{ html: string }>> {
    return this.call(() => this.api?.docReviewReadArtifact({ reviewId }));
  }

  async submitDecision(payload: {
    reviewId: string;
    overall: DocReviewOverall;
    decisions: DocReviewItemDecision[];
    generalComment?: string;
  }): Promise<IpcResponse<DocReviewSession>> {
    return this.call(() => this.api?.docReviewSubmitDecision(payload));
  }

  async dismiss(reviewId: string): Promise<IpcResponse<{ reviewId: string }>> {
    return this.call(() => this.api?.docReviewDismiss({ reviewId }));
  }

  async retryDelivery(reviewId: string): Promise<IpcResponse<DocReviewSession>> {
    return this.call(() => this.api?.docReviewRetryDelivery({ reviewId }));
  }

  async openExternal(reviewId: string): Promise<IpcResponse<{ reviewId: string }>> {
    return this.call(() => this.api?.docReviewOpenExternal({ reviewId }));
  }

  onChanged(callback: (event: unknown) => void): () => void {
    if (!this.api) return () => { /* not in Electron */ };
    return this.api.onDocReviewChanged((event) => {
      this.ngZone.run(() => callback(event));
    });
  }

  private async call<T>(
    fn: () => Promise<IpcResponse> | undefined,
  ): Promise<IpcResponse<T>> {
    const response = await fn();
    return response ? (response as IpcResponse<T>) : this.notInElectron<T>();
  }

  private notInElectron<T>(): IpcResponse<T> {
    return { success: false, error: { message: 'Not in Electron' } };
  }
}
