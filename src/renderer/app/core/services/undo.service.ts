import { Injectable, inject } from '@angular/core';
import { ToastService } from './toast.service';
export interface UndoRegistration {
  kind: string;
  message: string;
  undo: () => boolean | Promise<boolean>;
  windowMs?: number;
}
interface UndoEntry extends UndoRegistration { toastId: string }
@Injectable({ providedIn: 'root' })
export class UndoService {
  private readonly toast = inject(ToastService);
  private readonly entries = new Map<string, UndoEntry>();
  /**
   * The keyboard Undo slot: exactly the newest registered action. `undoLast()`
   * reaches only this one and consumes it on use — there is no Undo stack.
   * Older live notices keep their own toast buttons until they expire.
   */
  private newest: UndoEntry | null = null;
  register(registration: UndoRegistration): void {
    this.prune();
    this.toast.dismissKey(`undo:${registration.kind}`);
    const entry: UndoEntry = { ...registration, toastId: '' };
    entry.toastId = this.toast.show(registration.message, 'success', { key: `undo:${registration.kind}`,
      durationMs: registration.windowMs ?? 5000, action: { label: 'Undo', run: () => this.restore(entry) } });
    this.entries.set(entry.kind, entry);
    this.newest = entry;
  }
  async undoLast(): Promise<void> {
    this.prune();
    const target = this.newest;
    if (!target) return;
    this.newest = null;
    if (this.entries.get(target.kind) === target) await this.restore(target);
  }
  private prune(): void {
    const visible = new Set(this.toast.toasts().map((toast) => toast.id));
    for (const [kind, entry] of this.entries) if (!visible.has(entry.toastId)) this.entries.delete(kind);
  }
  private async restore(entry: UndoEntry): Promise<void> {
    this.prune();
    if (this.entries.get(entry.kind) !== entry) return;
    if (this.newest === entry) this.newest = null;
    this.entries.delete(entry.kind); this.toast.dismiss(entry.toastId);
    try {
      if (!await entry.undo()) throw new Error('unavailable');
      this.toast.show(`Restored: ${entry.message}`, 'success', { durationMs: 2000 });
    } catch { this.toast.show("Couldn't undo that. It is no longer available.", 'error'); }
  }
}
