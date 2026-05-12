/**
 * Per-repo actions toolbar (Phase 2d items 9, 10, 11).
 *
 * Renders three things, depending on repo state:
 *   - Commit message input + Commit button (item 9). The draft is held
 *     in `SourceControlStore.commitMessages` so it survives panel
 *     re-renders.
 *   - Sync row: Fetch / Pull / Push buttons + a Cancel button when a
 *     long-running op is in flight (item 10).
 *   - Branch picker dropdown (item 11). Click opens a menu of branches
 *     fetched from `vcsGetBranches`; clicking a branch invokes
 *     `store.checkoutBranch`. If git returns "would be overwritten"
 *     we surface a confirmation dialog and retry with `force: true`.
 *
 * The component is intentionally a child of the SourceControlComponent
 * (one per repo). It keeps the parent template short and the actions
 * testable in isolation.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { SourceControlStore } from '../../core/state/source-control.store';
import { VcsIpcService } from '../../core/services/ipc/vcs-ipc.service';
import type { BranchInfo, RepoState } from './source-control.types';

@Component({
  selector: 'app-source-control-repo-actions',
  standalone: true,
  template: `
    <!-- ============================================================
         Sync row (Phase 2d item 10): fetch / pull / push + cancel.
         The same long-op slot is shared by all three: fetch runs first,
         then pull (if there's an upstream), then push. They're three
         buttons because each is a deliberate action.
         ============================================================ -->
    <div class="actions-row sync-row">
      @if (longOp(); as op) {
        <div class="op-status" [attr.data-kind]="op.kind">
          <span class="op-spinner" aria-hidden="true"></span>
          <span class="op-label">{{ opLabel(op.kind) }}…</span>
          <button type="button" class="op-cancel" (click)="onCancelOp()">Cancel</button>
        </div>
      } @else {
        <button
          type="button"
          class="action-btn"
          (click)="onFetch()"
          [disabled]="isWriting()"
          title="Fetch (git fetch --prune)"
        >Fetch</button>
        <button
          type="button"
          class="action-btn"
          (click)="onPull()"
          [disabled]="isWriting() || !canPull()"
          [title]="pullTitle()"
        >Pull</button>
        <button
          type="button"
          class="action-btn action-btn-primary"
          (click)="onPush()"
          [disabled]="isWriting() || !canPush()"
          [title]="pushTitle()"
        >Push{{ aheadSuffix() }}</button>
      }

      <span class="actions-spacer"></span>

      <!-- ============================================================
           Branch picker (Phase 2d item 11). Click to open menu.
           ============================================================ -->
      <div class="branch-picker">
        <button
          type="button"
          class="action-btn branch-picker-button"
          (click)="onToggleBranchMenu()"
          [disabled]="isWriting()"
          [title]="'Switch branch (current: ' + branchName() + ')'"
        >⎇ {{ branchName() }} <span class="caret">▾</span></button>
        @if (branchMenuOpen()) {
          <div class="branch-menu" role="menu">
            @if (branchesLoading()) {
              <div class="branch-menu-loading">Loading branches…</div>
            } @else if (branchesError()) {
              <div class="branch-menu-error">{{ branchesError() }}</div>
            } @else if (branches().length === 0) {
              <div class="branch-menu-empty">No branches found</div>
            } @else {
              @for (b of branches(); track b.name) {
                <button
                  type="button"
                  class="branch-menu-item"
                  [class.current]="b.current"
                  (click)="onSelectBranch(b.name)"
                >
                  <span class="branch-menu-marker">{{ b.current ? '●' : '○' }}</span>
                  <span class="branch-menu-name">{{ b.name }}</span>
                  @if (b.tracking) {
                    <span class="branch-menu-tracking">{{ b.tracking }}</span>
                  }
                </button>
              }
            }
          </div>
        }
      </div>
    </div>

    <!-- ============================================================
         Commit input (Phase 2d item 9). Hidden when there are no
         staged changes — there's nothing to commit.
         ============================================================ -->
    @if (canCommit()) {
      <div class="commit-block">
        <textarea
          class="commit-message"
          [value]="commitMessageValue()"
          (input)="onCommitMessageInput($event)"
          (keydown.meta.enter)="onCommit()"
          (keydown.control.enter)="onCommit()"
          placeholder="Commit message — ⌘+Enter to commit"
          rows="2"
          [disabled]="isWriting()"
          aria-label="Commit message"
        ></textarea>
        <div class="commit-row">
          <label class="commit-signoff">
            <input
              type="checkbox"
              [checked]="signoff()"
              (change)="onToggleSignoff($event)"
            />
            <span>Sign-off</span>
          </label>
          <span class="commit-spacer"></span>
          <button
            type="button"
            class="action-btn action-btn-primary"
            (click)="onCommit()"
            [disabled]="isWriting() || !commitMessageValue().trim()"
            title="Commit staged changes (⌘+Enter)"
          >Commit ({{ stagedCount() }})</button>
        </div>
      </div>
    }
  `,
  styles: [`
    :host {
      display: block;
      padding: 6px 12px 4px 28px;
    }

    .actions-row {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    .action-btn {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-secondary);
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      padding: 4px 10px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all var(--transition-fast);
    }

    .action-btn:hover:not(:disabled) {
      color: var(--text-primary);
      background: var(--bg-hover);
      border-color: var(--secondary-color);
    }

    .action-btn:disabled {
      opacity: 0.4;
      cursor: default;
    }

    .action-btn-primary {
      color: var(--text-primary);
      background: rgba(var(--secondary-rgb), 0.12);
      border-color: rgba(var(--secondary-rgb), 0.4);
    }

    .action-btn-primary:hover:not(:disabled) {
      background: rgba(var(--secondary-rgb), 0.22);
      border-color: var(--secondary-color);
    }

    .branch-picker {
      position: relative;
    }

    .branch-picker-button {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .caret {
      font-size: 8px;
      opacity: 0.6;
    }

    .branch-menu {
      position: absolute;
      top: 100%;
      right: 0;
      margin-top: 4px;
      min-width: 200px;
      max-height: 240px;
      overflow-y: auto;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      z-index: 50;
    }

    .branch-menu-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      width: 100%;
      background: transparent;
      border: none;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-secondary);
      cursor: pointer;
      text-align: left;
      transition: background var(--transition-fast);
    }

    .branch-menu-item:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
    }

    .branch-menu-item.current {
      color: var(--text-primary);
    }

    .branch-menu-marker {
      width: 10px;
      color: var(--secondary-color);
      font-size: 9px;
    }

    .branch-menu-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .branch-menu-tracking {
      color: var(--text-muted);
      font-size: 10px;
    }

    .branch-menu-loading,
    .branch-menu-error,
    .branch-menu-empty {
      padding: 8px 12px;
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-muted);
    }

    .branch-menu-error {
      color: var(--error-color);
    }

    .actions-spacer {
      flex: 1;
    }

    .op-status {
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-secondary);
    }

    .op-spinner {
      width: 10px;
      height: 10px;
      border: 1.5px solid var(--border-subtle);
      border-top-color: var(--secondary-color);
      border-radius: 50%;
      animation: rep-spin 0.7s linear infinite;
    }

    @keyframes rep-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .op-cancel {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-muted);
      background: transparent;
      border: 1px solid var(--border-subtle);
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      cursor: pointer;
    }

    .op-cancel:hover {
      color: var(--text-primary);
      border-color: var(--secondary-color);
    }

    .commit-block {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 8px;
    }

    .commit-message {
      width: 100%;
      box-sizing: border-box;
      resize: vertical;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-primary);
      background: var(--bg-primary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 6px 8px;
      min-height: 34px;
    }

    .commit-message:focus {
      outline: none;
      border-color: var(--secondary-color);
    }

    .commit-message:disabled {
      opacity: 0.5;
    }

    .commit-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .commit-signoff {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-muted);
      cursor: pointer;
      user-select: none;
    }

    .commit-signoff input[type='checkbox'] {
      margin: 0;
    }

    .commit-spacer {
      flex: 1;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SourceControlRepoActionsComponent {
  private store = inject(SourceControlStore);
  private vcs = inject(VcsIpcService);

  repo = input.required<RepoState>();

  // ------- branch picker state -------
  protected branchMenuOpen = signal(false);
  protected branches = signal<BranchInfo[]>([]);
  protected branchesLoading = signal(false);
  protected branchesError = signal<string | null>(null);

  // ------- commit state -------
  protected signoff = signal(false);

  // ------- derived state -------
  protected branchName = computed(() => this.repo().status?.branch ?? 'HEAD');
  protected stagedCount = computed(() => this.repo().status?.staged.length ?? 0);
  protected canCommit = computed(() => this.stagedCount() > 0);
  protected canPull = computed(() => (this.repo().status?.behind ?? 0) > 0);
  protected canPush = computed(() => (this.repo().status?.ahead ?? 0) > 0);
  protected aheadSuffix = computed(() => {
    const a = this.repo().status?.ahead ?? 0;
    return a > 0 ? ` (${a})` : '';
  });

  protected longOp = computed(() => this.store.longOpState(this.repo().absolutePath));

  protected commitMessageValue = computed(() => this.store.getCommitMessage(this.repo().absolutePath));

  isWriting(): boolean {
    return this.store.isWriting(this.repo().absolutePath);
  }

  protected pullTitle(): string {
    if (!this.canPull()) return 'Nothing to pull (up to date)';
    return `Pull ${this.repo().status?.behind ?? 0} commit(s) from upstream (fast-forward only)`;
  }

  protected pushTitle(): string {
    if (!this.canPush()) return 'Nothing to push';
    return `Push ${this.repo().status?.ahead ?? 0} commit(s) to upstream`;
  }

  protected opLabel(kind: 'fetch' | 'pull' | 'push'): string {
    return kind.charAt(0).toUpperCase() + kind.slice(1);
  }

  // -------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------

  protected onFetch(): void {
    void this.store.fetch(this.repo().absolutePath);
  }

  protected onPull(): void {
    void this.store.pull(this.repo().absolutePath);
  }

  protected onPush(): void {
    void this.store.push(this.repo().absolutePath);
  }

  protected onCancelOp(): void {
    void this.store.cancelLongRunningOp(this.repo().absolutePath);
  }

  protected onToggleSignoff(event: Event): void {
    this.signoff.set((event.target as HTMLInputElement).checked);
  }

  protected onCommitMessageInput(event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    this.store.setCommitMessage(this.repo().absolutePath, value);
  }

  protected async onCommit(): Promise<void> {
    const message = this.commitMessageValue().trim();
    if (!message) return;
    await this.store.commit(this.repo().absolutePath, {
      message,
      signoff: this.signoff(),
    });
  }

  // ------- branch picker -------

  protected async onToggleBranchMenu(): Promise<void> {
    const willOpen = !this.branchMenuOpen();
    this.branchMenuOpen.set(willOpen);
    if (willOpen && this.branches().length === 0) {
      await this.loadBranches();
    }
  }

  protected async loadBranches(): Promise<void> {
    this.branchesLoading.set(true);
    this.branchesError.set(null);
    try {
      const response = await this.vcs.vcsGetBranches(this.repo().absolutePath);
      if (!response.success) {
        this.branchesError.set(response.error?.message ?? 'Failed to load branches');
        return;
      }
      const data = response.data as { branches: BranchInfo[] };
      this.branches.set(data.branches);
    } catch (err) {
      this.branchesError.set((err as Error).message);
    } finally {
      this.branchesLoading.set(false);
    }
  }

  protected async onSelectBranch(name: string): Promise<void> {
    this.branchMenuOpen.set(false);
    if (name === this.branchName()) return;

    const repoPath = this.repo().absolutePath;
    const outcome = await this.store.checkoutBranch(repoPath, name);
    if (outcome.success) return;

    if (outcome.dirty) {
      const confirmed = window.confirm(
        `Switching to "${name}" would overwrite uncommitted changes.\n\n` +
        `Continue and DISCARD your local changes? This cannot be undone.`,
      );
      if (!confirmed) return;
      await this.store.checkoutBranch(repoPath, name, { force: true });
    } else if (outcome.error) {
      window.alert(`Could not switch to "${name}":\n${outcome.error}`);
    }
  }
}
