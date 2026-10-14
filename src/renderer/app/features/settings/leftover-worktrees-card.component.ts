import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import type { LeftoverRemovalAction, LeftoverWorktreeRow } from '@contracts/schemas/workspace-tools';
import { LeftoverWorktreesStore } from '../../core/state/leftover-worktrees.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../shared/tooltip/tooltip-copy';
import { createFocusTrap, type FocusTrapHandle } from '../../shared/utils/focus-trap';

@Component({
  selector: 'app-leftover-worktrees-card', standalone: true,
  imports: [AioTooltipDirective], changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './leftover-worktrees-card.component.html',
  styleUrl: './leftover-worktrees-card.component.scss',
})
export class LeftoverWorktreesCardComponent implements OnDestroy {
  readonly workingDirectory = input<string | undefined>();
  readonly store = inject(LeftoverWorktreesStore);
  readonly discardConfirmed = signal(false);
  readonly copiedPath = signal<string | null>(null);
  readonly clipboardError = signal<string | null>(null);
  readonly reviewHint = copyFor('workFolders.review');
  readonly refreshHint = copyFor('workFolders.refresh');
  private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');
  private readonly cancelButton = viewChild<ElementRef<HTMLButtonElement>>('cancelButton');
  private focusTrap: FocusTrapHandle | null = null;

  constructor() {
    effect(() => { const cwd = this.workingDirectory(); untracked(() => { void this.store.load(cwd); }); });
    effect(() => {
      const preview = this.store.preview();
      const dialog = this.dialog()?.nativeElement;
      if (!preview || !dialog) { this.closeFocusTrap(); return; }
      if (!this.focusTrap) {
        this.focusTrap = createFocusTrap(dialog, { initialFocus: this.cancelButton()?.nativeElement });
        this.focusTrap.activate();
      }
    });
  }
  ngOnDestroy(): void { this.store.cancel(); this.closeFocusTrap(); }
  private closeFocusTrap(): void { this.focusTrap?.deactivate(); this.focusTrap?.restore(); this.focusTrap = null; }
  folderName(row: LeftoverWorktreeRow): string { return row.path.split(/[\\/]/).filter(Boolean).at(-1) ?? row.path; }
  maker(row: LeftoverWorktreeRow): string {
    return row.createdBy === 'harness' ? row.owner?.kind === 'queue' ? 'Made by a Harness plan queue' : 'Made by a Harness loop'
      : row.createdBy === 'claude-code' ? 'Made by Claude Code' : 'Not made by a Harness loop';
  }
  ownerLabel(row: LeftoverWorktreeRow): string {
    return row.owner?.kind === 'loop' && !row.owner.inUse ? 'Loop closed'
      : row.owner ? `${row.owner.kind === 'queue' ? 'Plan queue' : row.owner.kind === 'loop' ? 'Loop' : 'Session'}: ${row.owner.status}` : '';
  }
  size(bytes: number): string { return bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(2)} GB` : `${(bytes / 1_000_000).toFixed(1)} MB`; }
  async review(row: LeftoverWorktreeRow, action: LeftoverRemovalAction = 'remove-folder'): Promise<void> {
    this.discardConfirmed.set(false); await this.store.review(row, action);
  }
  async changeAction(event: Event, row: LeftoverWorktreeRow): Promise<void> {
    const value = (event.target as HTMLSelectElement).value;
    if (value === 'remove-folder' || value === 'remove-folder-and-branch' || value === 'discard-saved-work') {
      await this.review(row, value);
    }
  }
  updateDiscardConfirmation(event: Event): void {
    this.discardConfirmed.set((event.target as HTMLInputElement).checked);
  }
  commands(row: LeftoverWorktreeRow): string {
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    return `git -C ${quote(row.repoRoot)} worktree remove -- ${quote(row.path)}\n` + (row.branch
      ? `git -C ${quote(row.repoRoot)} branch -d -- ${quote(row.branch)}`
      : `git -C ${quote(row.repoRoot)} worktree list`);
  }
  async copyCommands(row: LeftoverWorktreeRow): Promise<void> {
    this.clipboardError.set(null);
    try { await navigator.clipboard.writeText(this.commands(row)); this.copiedPath.set(row.path); }
    catch (error) { this.clipboardError.set(error instanceof Error ? error.message : String(error)); }
  }
}
