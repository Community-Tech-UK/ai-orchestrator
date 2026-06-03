/**
 * Checkpoint Timeline Component
 *
 * Renders a vertical timeline of session snapshots (checkpoints) for an
 * instance.  Each entry shows timestamp, label, message count, and a Restore
 * button.  The Restore button requires a confirmation guard before calling
 * the session continuity resume IPC.
 *
 * Usage:
 *   <app-checkpoint-timeline [instanceId]="myInstanceId()" (restored)="onRestored($event)" />
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule, DecimalPipe } from '@angular/common';
import { HistoryIpcService } from '../../core/services/ipc/history-ipc.service';

/** Minimal projection of a SessionSnapshot returned by SESSION_LIST_SNAPSHOTS */
export interface CheckpointEntry {
  id: string;
  instanceId: string;
  timestamp: number;
  name?: string;
  description?: string;
  metadata: {
    messageCount: number;
    tokensUsed: number;
    trigger: string;
  };
}

@Component({
  selector: 'app-checkpoint-timeline',
  standalone: true,
  imports: [CommonModule, DecimalPipe],
  templateUrl: './checkpoint-timeline.component.html',
  styleUrl: './checkpoint-timeline.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CheckpointTimelineComponent implements OnInit {
  // ---- Inputs / Outputs ----

  /** Instance ID whose checkpoints to display */
  readonly instanceId = input.required<string>();

  /** Emits the restored instanceId (or snapshot id) after a successful restore */
  readonly restored = output<string>();

  // ---- DI ----

  private readonly historyIpc = inject(HistoryIpcService);

  // ---- State signals ----

  readonly checkpoints = signal<CheckpointEntry[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  /** The checkpoint ID awaiting user confirmation before restore */
  readonly pendingRestoreId = signal<string | null>(null);

  readonly restoring = signal(false);

  // ---- Derived ----

  readonly isEmpty = computed(() => !this.loading() && this.checkpoints().length === 0 && !this.error());

  readonly pendingCheckpoint = computed(() => {
    const id = this.pendingRestoreId();
    if (!id) return null;
    return this.checkpoints().find((c) => c.id === id) ?? null;
  });

  // ---- Lifecycle ----

  ngOnInit(): void {
    void this.load();
  }

  // ---- Public methods ----

  async load(): Promise<void> {
    const id = this.instanceId();
    if (!id) return;

    this.loading.set(true);
    this.error.set(null);

    try {
      const response = await this.historyIpc.listSessionSnapshots(id);
      if (response.success) {
        const raw = (response.data ?? []) as CheckpointEntry[];
        // Sort newest first so the timeline reads top-to-bottom newest → oldest
        const sorted = [...raw].sort((a, b) => b.timestamp - a.timestamp);
        this.checkpoints.set(sorted);
      } else {
        this.error.set(response.error?.message ?? 'Failed to load checkpoints');
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Unexpected error');
    } finally {
      this.loading.set(false);
    }
  }

  requestRestore(checkpointId: string): void {
    this.pendingRestoreId.set(checkpointId);
  }

  cancelRestore(): void {
    this.pendingRestoreId.set(null);
  }

  async confirmRestore(): Promise<void> {
    const id = this.pendingRestoreId();
    if (!id) return;

    this.pendingRestoreId.set(null);
    this.restoring.set(true);
    this.error.set(null);

    try {
      const response = await this.historyIpc.resumeSession(this.instanceId(), {
        fromSnapshot: id,
        restoreMessages: true,
        restoreContext: true,
        restoreTasks: true,
      });

      if (response.success) {
        this.restored.emit(id);
        await this.load();
      } else {
        this.error.set(response.error?.message ?? 'Restore failed');
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Restore failed');
    } finally {
      this.restoring.set(false);
    }
  }

  // ---- Display helpers ----

  formatDate(ts: number): string {
    try {
      return new Date(ts).toLocaleString(undefined, {
        dateStyle: 'short',
        timeStyle: 'short',
      });
    } catch {
      return String(ts);
    }
  }

  triggerLabel(trigger: string): string {
    switch (trigger) {
      case 'auto': return 'Auto';
      case 'manual': return 'Manual';
      case 'checkpoint': return 'Checkpoint';
      default: return trigger;
    }
  }

  entryLabel(entry: CheckpointEntry): string {
    if (entry.name) return entry.name;
    if (entry.description) return entry.description;
    return `Checkpoint ${entry.id.slice(-6)}`;
  }
}
