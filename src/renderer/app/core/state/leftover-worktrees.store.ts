import { Injectable, inject, signal } from '@angular/core';
import { IPC_CHANNELS } from '@contracts/channels';
import type { LeftoverRemovalAction, LeftoverRemovalPreview, LeftoverWorktreeReport,
  LeftoverWorktreeRow, LeftoverWorktreeArchive } from '@contracts/schemas/workspace-tools';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class LeftoverWorktreesStore {
  private readonly ipc = inject(ElectronIpcService);
  readonly archives = signal<LeftoverWorktreeArchive[]>([]);
  private readonly _rows = signal<LeftoverWorktreeRow[]>([]);
  private readonly _preview = signal<LeftoverRemovalPreview | null>(null);
  private readonly _busy = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly _reportErrors = signal<LeftoverWorktreeReport['errors']>([]);
  private previewEpoch = 0;
  private running = false;
  readonly rows = this._rows.asReadonly();
  readonly preview = this._preview.asReadonly();
  readonly busy = this._busy.asReadonly();
  readonly error = this._error.asReadonly();
  readonly reportErrors = this._reportErrors.asReadonly();

  async load(workingDirectory?: string): Promise<void> {
    if (this._busy()) return;
    this._busy.set(true); this._error.set(null);
    try {
      const response = await this.ipc.invoke<LeftoverWorktreeReport>(IPC_CHANNELS.WORKTREE_LEFTOVERS_LIST, { workingDirectory });
      if (!response.success || !response.data) throw new Error(response.error?.message ?? 'Could not read work folders');
      this.archives.set(response.data.archives ?? []); this._rows.set(response.data.rows); this._reportErrors.set(response.data.errors);
    } catch (error) { this._error.set(error instanceof Error ? error.message : String(error)); }
    finally { this._busy.set(false); }
  }

  async review(row: LeftoverWorktreeRow, action: LeftoverRemovalAction, archiveId?: string): Promise<void> {
    if (this._busy() || !(row.removableByHarness || row.archivableByHarness || (action === 'restore-folder' && archiveId))) return;
    const epoch = ++this.previewEpoch;
    this._preview.set(null); this._busy.set(true); this._error.set(null);
    try {
      const response = await this.ipc.invoke<LeftoverRemovalPreview>(IPC_CHANNELS.WORKTREE_LEFTOVERS_PREVIEW,
        { repoRoot: row.repoRoot, path: row.path, action, ...(archiveId ? { archiveId } : {}) });
      if (!response.success || !response.data) throw new Error(response.error?.message ?? 'Could not preview folder removal');
      if (epoch === this.previewEpoch) this._preview.set(response.data);
    } catch (error) { this._error.set(error instanceof Error ? error.message : String(error)); }
    finally { this._busy.set(false); }
  }

  cancel(): void {
    if (this.running) return;
    this.previewEpoch++; this._preview.set(null);
  }

  async run(discardSavedWork: boolean, workingDirectory?: string): Promise<void> {
    const preview = this._preview();
    if (!preview || this._busy() || (preview.action === 'discard-saved-work' && !discardSavedWork)) return;
    this.running = true; this._busy.set(true); this._error.set(null);
    let removed = false;
    try {
      const response = await this.ipc.invoke(IPC_CHANNELS.WORKTREE_LEFTOVERS_REMOVE, {
        repoRoot: preview.row.repoRoot, path: preview.row.path, action: preview.action,
        previewId: preview.previewId, discardSavedWork, ...(preview.archiveId ? { archiveId: preview.archiveId } : {}),
      });
      if (!response.success) throw new Error(response.error?.message ?? 'Folder removal failed');
      removed = true;
    } catch (error) { this._error.set(error instanceof Error ? error.message : String(error)); }
    finally { this.running = false; this._busy.set(false); this.cancel(); }
    if (removed) await this.load(workingDirectory);
  }
}
