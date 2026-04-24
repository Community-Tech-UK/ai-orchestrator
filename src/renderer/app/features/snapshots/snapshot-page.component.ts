/**
 * Snapshot Page
 * File snapshot browser with diff viewing and revert operations.
 */

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { SnapshotIpcService } from '../../core/services/ipc/snapshot-ipc.service';
import { SessionShareIpcService } from '../../core/services/ipc/session-share-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import { DiffViewerComponent } from '../../shared/components/diff-viewer/diff-viewer.component';
import type { SessionShareAttachment, SessionShareBundle } from '../../../../shared/types/session-share.types';

interface SnapshotSession {
  id: string;
  instanceId: string;
  description?: string;
  startedAt: string;
  endedAt?: string;
  fileCount?: number;
}

interface SnapshotEntry {
  id: string;
  filePath: string;
  action: 'create' | 'modify' | 'delete';
  createdAt: string;
  sessionId?: string;
}

interface SnapshotStats {
  totalSnapshots: number;
  totalSessions: number;
  storageUsedBytes: number;
  oldestSnapshot?: string;
}

interface SnapshotDiff {
  oldContent: string;
  newContent: string;
  filePath: string;
}

@Component({
  selector: 'app-snapshot-page',
  standalone: true,
  imports: [CommonModule, DiffViewerComponent],
  templateUrl: './snapshot-page.component.html',
  styleUrl: './snapshot-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SnapshotPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly snapshotIpc = inject(SnapshotIpcService);
  private readonly sessionShareIpc = inject(SessionShareIpcService);

  // ---- State signals ----

  readonly sessions = signal<SnapshotSession[]>([]);
  readonly snapshots = signal<SnapshotEntry[]>([]);

  readonly selectedInstanceId = signal('');
  readonly selectedSessionId = signal<string | null>(null);
  readonly selectedSnapshotId = signal<string | null>(null);

  readonly stats = signal<SnapshotStats | null>(null);
  readonly currentDiff = signal<SnapshotDiff | null>(null);
  readonly evidenceBundle = signal<SessionShareBundle | null>(null);

  readonly loading = signal(false);
  readonly loadingDiff = signal(false);
  readonly loadingEvidence = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly infoMessage = signal<string | null>(null);

  /** Set to 'file' or 'session' when awaiting user confirmation. */
  readonly confirmRevert = signal<'file' | 'session' | null>(null);

  // ---- Derived ----

  readonly selectedSession = computed(() =>
    this.sessions().find((s) => s.id === this.selectedSessionId()) ?? null
  );

  readonly selectedSnapshot = computed(() =>
    this.snapshots().find((s) => s.id === this.selectedSnapshotId()) ?? null
  );

  readonly canRevertFile = computed(
    () => this.selectedSnapshotId() !== null
  );

  readonly canRevertSession = computed(
    () => this.selectedSessionId() !== null
  );

  constructor() {
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((query) => {
        const instanceId = query.get('instanceId')?.trim() || '';
        if (!instanceId || instanceId === this.selectedInstanceId().trim()) {
          return;
        }

        this.selectedInstanceId.set(instanceId);
        void this.loadSessions(instanceId);
      });
  }

  // ---- Lifecycle ----

  async ngOnInit(): Promise<void> {
    await this.loadStats();
  }

  ngOnDestroy(): void {
    this.confirmRevert.set(null);
  }

  // ---- Navigation ----

  goBack(): void {
    this.router.navigate(['/']);
  }

  // ---- Public event handlers ----

  onInstanceIdInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.selectedInstanceId.set(target.value);
  }

  openReplay(): void {
    const instanceId = this.selectedInstanceId().trim();
    if (!instanceId) {
      return;
    }

    void this.router.navigate(['/replay'], {
      queryParams: { instanceId },
    });
  }

  async refresh(): Promise<void> {
    this.clearMessages();
    await this.loadStats();
    const instanceId = this.selectedInstanceId().trim();
    if (instanceId) {
      await this.loadSessions(instanceId);
    }
  }

  async loadSessions(instanceId: string): Promise<void> {
    if (!instanceId.trim()) return;
    this.clearMessages();
    this.loading.set(true);
    this.loadingEvidence.set(true);
    this.sessions.set([]);
    this.snapshots.set([]);
    this.selectedSessionId.set(null);
    this.selectedSnapshotId.set(null);
    this.currentDiff.set(null);
    this.evidenceBundle.set(null);

    try {
      const response = await this.snapshotIpc.snapshotGetSessions(instanceId.trim());
      const data = this.unwrapData<SnapshotSession[]>(response, []);
      this.sessions.set(data);
      await this.loadEvidence(instanceId.trim());
    } finally {
      this.loading.set(false);
      if (this.loadingEvidence() && !this.evidenceBundle()) {
        this.loadingEvidence.set(false);
      }
    }
  }

  async selectSession(session: SnapshotSession): Promise<void> {
    if (this.selectedSessionId() === session.id) return;
    this.clearMessages();
    this.selectedSessionId.set(session.id);
    this.selectedSnapshotId.set(null);
    this.currentDiff.set(null);
    this.snapshots.set([]);
    await this.loadSnapshots(session.id);
  }

  async selectSnapshot(snapshot: SnapshotEntry): Promise<void> {
    if (this.selectedSnapshotId() === snapshot.id) return;
    this.clearMessages();
    this.selectedSnapshotId.set(snapshot.id);
    this.currentDiff.set(null);
    await this.loadDiff(snapshot.id);
  }

  async runCleanup(): Promise<void> {
    this.clearMessages();
    this.loading.set(true);
    try {
      const response = await this.snapshotIpc.snapshotCleanup();
      if (response.success) {
        this.infoMessage.set('Cleanup completed successfully.');
        await this.loadStats();
      } else {
        this.errorMessage.set(response.error?.message ?? 'Cleanup failed.');
      }
    } finally {
      this.loading.set(false);
    }
  }

  async deleteSnapshot(): Promise<void> {
    const id = this.selectedSnapshotId();
    if (!id) return;
    this.clearMessages();
    this.loading.set(true);
    try {
      const response = await this.snapshotIpc.snapshotDelete(id);
      if (response.success) {
        this.infoMessage.set('Snapshot deleted.');
        this.selectedSnapshotId.set(null);
        this.currentDiff.set(null);
        this.snapshots.update((list) => list.filter((s) => s.id !== id));
        await this.loadStats();
      } else {
        this.errorMessage.set(response.error?.message ?? 'Delete failed.');
      }
    } finally {
      this.loading.set(false);
    }
  }

  async executeRevert(): Promise<void> {
    const mode = this.confirmRevert();
    if (!mode) return;

    this.confirmRevert.set(null);
    this.clearMessages();
    this.loading.set(true);

    try {
      if (mode === 'file') {
        const snapshotId = this.selectedSnapshotId();
        if (!snapshotId) return;
        const response = await this.snapshotIpc.snapshotRevertFile(snapshotId);
        if (response.success) {
          this.infoMessage.set('File reverted successfully.');
        } else {
          this.errorMessage.set(response.error?.message ?? 'Revert failed.');
        }
      } else {
        const sessionId = this.selectedSessionId();
        if (!sessionId) return;
        const response = await this.snapshotIpc.snapshotRevertSession(sessionId);
        if (response.success) {
          this.infoMessage.set('Session reverted successfully.');
        } else {
          this.errorMessage.set(response.error?.message ?? 'Session revert failed.');
        }
      }
    } finally {
      this.loading.set(false);
    }
  }

  // ---- Display helpers ----

  actionIcon(action: 'create' | 'modify' | 'delete'): string {
    switch (action) {
      case 'create': return '+';
      case 'modify': return '~';
      case 'delete': return '−';
    }
  }

  shortPath(filePath: string): string {
    if (!filePath) return '';
    const parts = filePath.replace(/\\/g, '/').split('/');
    return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : filePath;
  }

  formatBytes(bytes?: number): string {
    if (bytes == null) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  formatDate(dateValue?: string | number): string {
    if (dateValue == null || dateValue === '') return '—';
    try {
      const normalized =
        typeof dateValue === 'string' && /^\d+$/.test(dateValue)
          ? Number(dateValue)
          : dateValue;
      return new Date(normalized).toLocaleString(undefined, {
        dateStyle: 'short',
        timeStyle: 'short',
      });
    } catch {
      return String(dateValue);
    }
  }

  formatAttachmentMeta(attachment: SessionShareAttachment): string {
    const parts: string[] = [];
    if (attachment.size != null) {
      parts.push(this.formatBytes(attachment.size));
    }
    if (attachment.timestamp) {
      parts.push(this.formatDate(attachment.timestamp));
    }
    return parts.join(' · ') || 'Attachment';
  }

  toDataUrl(attachment: SessionShareAttachment): string {
    return `data:${attachment.mediaType || 'application/octet-stream'};base64,${attachment.embeddedBase64}`;
  }

  // ---- Private helpers ----

  private async loadStats(): Promise<void> {
    const response = await this.snapshotIpc.snapshotGetStats();
    const data = this.unwrapData<SnapshotStats>(response, {
      totalSnapshots: 0,
      totalSessions: 0,
      storageUsedBytes: 0,
    });
    this.stats.set(data);
  }

  private async loadSnapshots(sessionId: string): Promise<void> {
    this.loading.set(true);
    try {
      const response = await this.snapshotIpc.snapshotGetForInstance(
        this.selectedInstanceId().trim()
      );
      const all = this.unwrapData<SnapshotEntry[]>(response, []);
      const filtered = all.filter((s) => s.sessionId === sessionId);
      this.snapshots.set(filtered);
    } finally {
      this.loading.set(false);
    }
  }

  private async loadDiff(snapshotId: string): Promise<void> {
    this.loadingDiff.set(true);
    try {
      const response = await this.snapshotIpc.snapshotGetDiff(snapshotId);
      if (response.success && response.data) {
        const raw = response.data as Record<string, unknown>;
        this.currentDiff.set({
          oldContent: String(raw['oldContent'] ?? ''),
          newContent: String(raw['newContent'] ?? ''),
          filePath: String(raw['filePath'] ?? ''),
        });
      } else {
        // Fallback: try to load raw content if diff not available
        const contentResponse = await this.snapshotIpc.snapshotGetContent(snapshotId);
        if (contentResponse.success && contentResponse.data) {
          const raw = contentResponse.data as Record<string, unknown>;
          const snap = this.selectedSnapshot();
          this.currentDiff.set({
            oldContent: String(raw['content'] ?? ''),
            newContent: '',
            filePath: snap?.filePath ?? '',
          });
        } else {
          this.currentDiff.set(null);
        }
      }
    } finally {
      this.loadingDiff.set(false);
    }
  }

  private clearMessages(): void {
    this.errorMessage.set(null);
    this.infoMessage.set(null);
  }

  private async loadEvidence(instanceId: string): Promise<void> {
    this.loadingEvidence.set(true);

    try {
      const response = await this.sessionShareIpc.previewForInstance(instanceId);
      if (!response.success || !response.data) {
        this.evidenceBundle.set(null);
        return;
      }

      this.evidenceBundle.set(response.data as SessionShareBundle);
    } catch {
      this.evidenceBundle.set(null);
    } finally {
      this.loadingEvidence.set(false);
    }
  }

  private unwrapData<T>(response: IpcResponse, fallback: T): T {
    return response.success ? ((response.data as T) ?? fallback) : fallback;
  }
}
