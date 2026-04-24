/**
 * VCS Page - Git Operations
 * Repository status, branches, commits, diffs, and file history.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { VcsIpcService } from '../../core/services/ipc/vcs-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import { DiffViewerComponent } from '../../shared/components/diff-viewer/diff-viewer.component';

// -----------------------------------------------------------------------
// Local interfaces
// -----------------------------------------------------------------------

interface GitStatus {
  modified: string[];
  added: string[];
  deleted: string[];
  untracked: string[];
  staged: string[];
  branch: string;
  ahead: number;
  behind: number;
}

interface GitBranch {
  name: string;
  current: boolean;
  remote?: string;
}

interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}

interface FileHistoryEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

type LeftTab = 'changes' | 'branches';

// -----------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------

@Component({
  selector: 'app-vcs-page',
  standalone: true,
  imports: [CommonModule, DiffViewerComponent],
  templateUrl: './vcs-page.component.html',
  styleUrl: './vcs-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VcsPageComponent {
  private readonly router = inject(Router);
  private readonly vcsIpc = inject(VcsIpcService);

  // -----------------------------------------------------------------------
  // State signals
  // -----------------------------------------------------------------------

  readonly workingDir = signal('');
  readonly isRepo = signal(false);
  readonly loading = signal(false);
  readonly errorMessage = signal<string | null>(null);

  readonly status = signal<GitStatus | null>(null);
  readonly branches = signal<GitBranch[]>([]);
  readonly commits = signal<GitCommit[]>([]);

  readonly leftTab = signal<LeftTab>('changes');

  readonly selectedFile = signal<string | null>(null);
  readonly selectedDiffType = signal<'staged' | 'unstaged'>('unstaged');
  readonly diffOld = signal('');
  readonly diffNew = signal('');
  readonly diffLoading = signal(false);

  readonly selectedCommit = signal<GitCommit | null>(null);

  readonly historyDrawerOpen = signal(false);
  readonly historyFilePath = signal('');
  readonly fileHistory = signal<FileHistoryEntry[]>([]);
  readonly historyLoading = signal(false);
  readonly jobUrl = signal('');

  // -----------------------------------------------------------------------
  // Computed
  // -----------------------------------------------------------------------

  readonly diffFileName = computed(() => this.selectedFile() ?? '');

  readonly totalChanges = computed(() => {
    const s = this.status();
    if (!s) return 0;
    return (
      s.modified.length +
      s.added.length +
      s.deleted.length +
      s.untracked.length +
      s.staged.length
    );
  });

  // -----------------------------------------------------------------------
  // Navigation
  // -----------------------------------------------------------------------

  goBack(): void {
    this.router.navigate(['/']);
  }

  // -----------------------------------------------------------------------
  // Directory / Repo loading
  // -----------------------------------------------------------------------

  onDirInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.workingDir.set(target.value);
  }

  onJobUrlInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.jobUrl.set(target.value);
  }

  openRepoJob(type: 'pr-review' | 'repo-health-audit'): void {
    if (!this.isRepo() || !this.workingDir().trim()) {
      return;
    }

    const queryParams: Record<string, string> = {
      workingDirectory: this.workingDir().trim(),
      branchRef: this.status()?.branch || '',
    };

    const baseBranch = this.getSuggestedBaseBranch();
    if (baseBranch) {
      queryParams['baseBranch'] = baseBranch;
    }

    const issueOrPrUrl = this.jobUrl().trim();
    if (issueOrPrUrl) {
      queryParams['issueOrPrUrl'] = issueOrPrUrl;
    }

    this.router.navigate(['/tasks'], {
      queryParams,
      state: {
        launchType: type,
      },
    });
  }

  async loadRepo(): Promise<void> {
    const dir = this.workingDir().trim();
    if (!dir) return;

    this.loading.set(true);
    this.errorMessage.set(null);
    this.isRepo.set(false);
    this.status.set(null);
    this.branches.set([]);
    this.commits.set([]);
    this.selectedFile.set(null);
    this.selectedCommit.set(null);
    this.fileHistory.set([]);

    try {
      const isRepoResponse = await this.vcsIpc.vcsIsRepo(dir);
      if (!isRepoResponse.success) {
        this.errorMessage.set(isRepoResponse.error?.message ?? 'Failed to check repository.');
        return;
      }

      const repoData = isRepoResponse.data as Record<string, unknown> | boolean | undefined;
      const isValidRepo =
        repoData === true ||
        (typeof repoData === 'object' && repoData !== null && repoData['isRepo'] === true);

      if (!isValidRepo) {
        this.errorMessage.set('Not a git repository.');
        return;
      }

      this.isRepo.set(true);
      await this.loadAll(dir);
    } catch (err) {
      this.errorMessage.set((err as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  async refresh(): Promise<void> {
    if (!this.isRepo()) return;
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      await this.loadAll(this.workingDir());
    } catch (err) {
      this.errorMessage.set((err as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  // -----------------------------------------------------------------------
  // File selection & diff loading
  // -----------------------------------------------------------------------

  selectFile(filePath: string, diffType: 'staged' | 'unstaged'): void {
    this.selectedFile.set(filePath);
    this.selectedDiffType.set(diffType);
    this.selectedCommit.set(null);
    void this.loadFileDiff(filePath, diffType);
  }

  async loadFileDiff(filePath: string, diffType: 'staged' | 'unstaged'): Promise<void> {
    this.diffLoading.set(true);
    this.diffOld.set('');
    this.diffNew.set('');

    try {
      const response = await this.vcsIpc.vcsGetDiff({
        workingDirectory: this.workingDir(),
        type: diffType,
        filePath,
      });

      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to load diff.');
        return;
      }

      this.applyDiffResponse(response);
    } catch (err) {
      this.errorMessage.set((err as Error).message);
    } finally {
      this.diffLoading.set(false);
    }
  }

  // -----------------------------------------------------------------------
  // Commit selection
  // -----------------------------------------------------------------------

  selectCommit(commit: GitCommit): void {
    this.selectedCommit.set(commit);
    this.selectedFile.set(null);
    void this.loadCommitDiff(commit);
  }

  async loadCommitDiff(commit: GitCommit): Promise<void> {
    this.diffLoading.set(true);
    this.diffOld.set('');
    this.diffNew.set('');

    try {
      const commitList = this.commits();
      const currentIndex = commitList.findIndex((c) => c.hash === commit.hash);
      const prevCommit = currentIndex < commitList.length - 1 ? commitList[currentIndex + 1] : null;

      const response = await this.vcsIpc.vcsGetDiff({
        workingDirectory: this.workingDir(),
        type: 'between',
        fromRef: prevCommit?.hash ?? `${commit.hash}^`,
        toRef: commit.hash,
      });

      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to load commit diff.');
        return;
      }

      this.applyDiffResponse(response);
    } catch (err) {
      this.errorMessage.set((err as Error).message);
    } finally {
      this.diffLoading.set(false);
    }
  }

  // -----------------------------------------------------------------------
  // File history (bottom drawer)
  // -----------------------------------------------------------------------

  onHistoryFileInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.historyFilePath.set(target.value);
  }

  async loadFileHistory(): Promise<void> {
    const filePath = this.historyFilePath().trim();
    if (!filePath || !this.isRepo()) return;

    this.historyLoading.set(true);
    this.fileHistory.set([]);

    try {
      const response = await this.vcsIpc.vcsGetFileHistory(this.workingDir(), filePath, 20);
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to load file history.');
        return;
      }

      const entries = this.extractArray<FileHistoryEntry>(response);
      this.fileHistory.set(entries);
    } catch (err) {
      this.errorMessage.set((err as Error).message);
    } finally {
      this.historyLoading.set(false);
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async loadAll(dir: string): Promise<void> {
    const [statusResponse, branchesResponse, commitsResponse] = await Promise.all([
      this.vcsIpc.vcsGetStatus(dir),
      this.vcsIpc.vcsGetBranches(dir),
      this.vcsIpc.vcsGetCommits(dir, 50),
    ]);

    if (statusResponse.success) {
      const raw = statusResponse.data as Partial<GitStatus> | undefined;
      this.status.set({
        modified: raw?.modified ?? [],
        added: raw?.added ?? [],
        deleted: raw?.deleted ?? [],
        untracked: raw?.untracked ?? [],
        staged: raw?.staged ?? [],
        branch: raw?.branch ?? '',
        ahead: raw?.ahead ?? 0,
        behind: raw?.behind ?? 0,
      });
    } else {
      this.errorMessage.set(statusResponse.error?.message ?? 'Failed to load status.');
    }

    if (branchesResponse.success) {
      this.branches.set(this.extractArray<GitBranch>(branchesResponse));
    } else {
      this.errorMessage.set(branchesResponse.error?.message ?? 'Failed to load branches.');
    }

    if (commitsResponse.success) {
      this.commits.set(this.extractArray<GitCommit>(commitsResponse));
    } else {
      this.errorMessage.set(commitsResponse.error?.message ?? 'Failed to load commits.');
    }
  }

  private applyDiffResponse(response: IpcResponse): void {
    const data = response.data as Record<string, unknown> | string | undefined;

    if (typeof data === 'string') {
      // Raw unified diff string — put it in newContent and leave oldContent empty
      this.diffOld.set('');
      this.diffNew.set(data);
      return;
    }

    if (data && typeof data === 'object') {
      this.diffOld.set(String(data['oldContent'] ?? data['before'] ?? ''));
      this.diffNew.set(String(data['newContent'] ?? data['after'] ?? data['diff'] ?? ''));
    }
  }

  private extractArray<T>(response: IpcResponse): T[] {
    if (!response.success) return [];
    const data = response.data;
    if (Array.isArray(data)) return data as T[];
    return [];
  }

  private getSuggestedBaseBranch(): string | null {
    const currentBranch = this.status()?.branch || '';
    const branchNames = this.branches().map((branch) => branch.name);
    const candidates = ['main', 'master', 'develop'];

    for (const candidate of candidates) {
      if (currentBranch === candidate) {
        continue;
      }

      const matched = branchNames.find((branchName) =>
        branchName === candidate || branchName.endsWith(`/${candidate}`),
      );
      if (matched) {
        return matched;
      }
    }

    return currentBranch || null;
  }
}
