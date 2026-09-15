import { Injectable, inject } from '@angular/core';
import { DraftStore } from './draft-store';
import type { MobileAttachmentDto } from './models';

type StoredTextMerger = (saved: string, recovered: string) => string;

type Receiver = (text: string, attachments: MobileAttachmentDto[]) => Promise<boolean>;

export function joinDraftText(current: string, recovered: string): string {
  if (!recovered) return current;
  return current.trim() ? `${current.trimEnd()}\n\n${recovered}` : recovered;
}

/** Delayed sends, queue returns and photo pickers can outlive their composer. */
@Injectable({ providedIn: 'root' })
export class ConversationDraftRecoveryService {
  private readonly drafts = inject(DraftStore);
  private readonly receivers = new Map<string, Receiver>();
  private pending: Promise<unknown> = Promise.resolve();

  attach(key: string, receiver: Receiver): () => void {
    this.receivers.set(key, receiver);
    return () => { if (this.receivers.get(key) === receiver) this.receivers.delete(key); };
  }

  /** Structured drafts may supply a storage-only merger, including config-only recovery. */
  recover(key: string, text: string, attachments: MobileAttachmentDto[], mergeStoredText?: StoredTextMerger): Promise<void> {
    return this.serialize(() => this.deliver(key, text, attachments, mergeStoredText));
  }

  /** Legacy drafts have no host identity: consume only after an explicit recovery. */
  recoverLegacy(key: string, legacyKey: string): Promise<boolean> {
    return this.serialize(async () => {
      const text = await this.drafts.load(legacyKey);
      if (!text) return false;
      await this.deliver(key, text, []);
      this.drafts.clear(legacyKey);
      return true;
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async deliver(key: string, text: string, attachments: MobileAttachmentDto[], mergeStoredText?: StoredTextMerger): Promise<void> {
    if (!text && !attachments.length && !mergeStoredText) return;
    // Read storage first, then locate the latest composer. An old receiver may
    // be destroyed while its initial draft load is pending; retry its successor.
    let rejected: Receiver | undefined;
    for (;;) {
      const saved = await this.drafts.load(key);
      const receiver = this.receivers.get(key);
      if (receiver && receiver !== rejected) {
        if (await receiver(text, attachments)) return;
        rejected = receiver;
        continue;
      }
      this.drafts.save(key, (mergeStoredText ?? joinDraftText)(saved, text));
      this.drafts.saveAttachments(key, [...this.drafts.attachments(key), ...attachments]);
      return;
    }
  }
}
