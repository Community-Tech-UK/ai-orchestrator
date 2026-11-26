import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { KnowledgeStore } from '../../core/state/knowledge.store';
import type { WakeHint } from '../../../../shared/types/wake-context.types';

interface PendingRemoval {
  note: WakeHint;
  remaining: number;
  started: number;
  timer?: ReturnType<typeof setTimeout>;
  pauses: Set<'pointer' | 'focus'>;
  deleting: boolean;
}

/** Memory-only Undo. Deletion is delayed so provenance, identity and history survive cancellation. */
@Injectable({ providedIn: 'root' })
export class ProjectNoteRemovalService implements OnDestroy {
  private readonly store = inject(KnowledgeStore);
  private readonly entries = new Map<string, PendingRemoval>();
  readonly pending = signal<readonly { id: string; content: string; deleting: boolean }[]>([]);
  readonly status = signal('');

  schedule(note: WakeHint): void {
    if (this.entries.has(note.id)) return;
    const entry: PendingRemoval = { note, remaining: 5000, started: Date.now(), pauses: new Set(), deleting: false };
    this.entries.set(note.id, entry);
    this.status.set('');
    this.start(entry);
    this.publish();
  }

  undo(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.deleting) return false;
    clearTimeout(entry.timer);
    this.entries.delete(id);
    this.status.set('Removal cancelled.');
    this.publish();
    return true;
  }

  undoLast(): boolean {
    const latest = [...this.entries.values()].reverse().find((entry) => !entry.deleting);
    return latest ? this.undo(latest.note.id) : false;
  }

  pause(id: string, reason: 'pointer' | 'focus'): void {
    const entry = this.entries.get(id);
    if (!entry || entry.deleting || entry.pauses.has(reason)) return;
    if (entry.pauses.size === 0) {
      clearTimeout(entry.timer);
      entry.remaining = Math.max(0, entry.remaining - (Date.now() - entry.started));
    }
    entry.pauses.add(reason);
  }

  resume(id: string, reason: 'pointer' | 'focus'): void {
    const entry = this.entries.get(id);
    if (!entry || entry.deleting || !entry.pauses.delete(reason)) return;
    if (entry.pauses.size === 0) this.start(entry);
  }

  resumeAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.pauses.size > 0) { entry.pauses.clear(); this.start(entry); }
    }
  }

  ngOnDestroy(): void {
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear(); // An app exit cannot turn pending removals into data loss.
  }

  private start(entry: PendingRemoval): void {
    entry.started = Date.now();
    entry.timer = setTimeout(() => void this.commit(entry), entry.remaining);
  }

  private async commit(entry: PendingRemoval): Promise<void> {
    if (entry.deleting || this.entries.get(entry.note.id) !== entry) return;
    entry.deleting = true;
    this.publish();
    try {
      const removed = await this.store.removeHint(entry.note.id);
      this.status.set(removed ? 'Note removed.' : 'Could not remove the note. It has been kept.');
    } catch {
      this.status.set('Could not remove the note. Refresh to check its status.');
    } finally {
      this.entries.delete(entry.note.id);
      this.publish();
    }
  }

  private publish(): void {
    this.pending.set([...this.entries.values()].map(({ note, deleting }) => ({ id: note.id, content: note.content, deleting })));
  }
}
