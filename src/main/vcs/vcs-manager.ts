/**
 * VCS Manager - Version Control System integration (Git)
 *
 * Provides git operations for file tracking, status, diffs, and history.
 * Uses execFileSync for safe command execution (no shell injection).
 */

import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// ============================================
// Types
// ============================================

export type FileChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'ignored';

export interface FileChange {
  path: string;
  status: FileChangeStatus;
  oldPath?: string;  // For renames
  staged: boolean;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: string[];
  hasChanges: boolean;
  isClean: boolean;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: Date;
  message: string;
  body?: string;
}

export interface BranchInfo {
  name: string;
  current: boolean;
  remote?: string;
  tracking?: string;
  ahead?: number;
  behind?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: FileChangeStatus;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

export interface DiffResult {
  files: DiffFile[];
  totalAdditions: number;
  totalDeletions: number;
}

export interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

// ============================================
// VCS Manager Class
// ============================================

export class VcsManager {
  private workingDirectory: string;

  constructor(workingDirectory: string) {
    this.workingDirectory = workingDirectory;
  }

  /**
   * Execute a git command safely using execFileSync
   * Returns stdout as string, or null if command fails
   */
  private execGit(args: string[], options?: { cwd?: string }): string | null {
    try {
      const result = execFileSync('git', args, {
        cwd: options?.cwd || this.workingDirectory,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
        timeout: 30000, // 30 second timeout
      });
      return result;
    } catch (error) {
      // Command failed or git not found
      return null;
    }
  }

  /**
   * Execute git command, throw on failure
   */
  private execGitOrThrow(args: string[], options?: { cwd?: string }): string {
    const result = this.execGit(args, options);
    if (result === null) {
      throw new Error(`Git command failed: git ${args.join(' ')}`);
    }
    return result;
  }

  // ============================================
  // Repository Detection
  // ============================================

  /**
   * Check if the working directory is inside a git repository
   */
  isGitRepository(): boolean {
    const result = this.execGit(['rev-parse', '--is-inside-work-tree']);
    return result?.trim() === 'true';
  }

  /**
   * Find the root directory of the git repository
   */
  findGitRoot(): string | null {
    const result = this.execGit(['rev-parse', '--show-toplevel']);
    return result?.trim() || null;
  }

  // ============================================
  // Status Operations
  // ============================================

  /**
   * Get comprehensive git status
   */
  getStatus(): GitStatus {
    const branch = this.getCurrentBranch() || 'HEAD';
    const trackingStatus = this.getTrackingStatus();

    // Get porcelain v2 status for detailed info
    const statusOutput = this.execGit(['status', '--porcelain=v2', '--branch', '-uno']) || '';
    const untrackedOutput = this.execGit(['ls-files', '--others', '--exclude-standard']) || '';

    const staged: FileChange[] = [];
    const unstaged: FileChange[] = [];
    const untracked: string[] = untrackedOutput.split('\n').filter(Boolean);

    // Parse porcelain v2 format
    const lines = statusOutput.split('\n');
    for (const line of lines) {
      if (!line || line.startsWith('#')) continue;

      if (line.startsWith('1 ') || line.startsWith('2 ')) {
        // Ordinary or renamed entry
        const parts = line.split(' ');
        const xy = parts[1]; // XY status
        const filePath = parts.slice(8).join(' '); // Path is after 8th field

        const indexStatus = xy[0];
        const workTreeStatus = xy[1];

        // Staged changes (index)
        if (indexStatus !== '.') {
          staged.push({
            path: filePath,
            status: this.parseStatusChar(indexStatus),
            staged: true,
          });
        }

        // Unstaged changes (work tree)
        if (workTreeStatus !== '.') {
          unstaged.push({
            path: filePath,
            status: this.parseStatusChar(workTreeStatus),
            staged: false,
          });
        }
      }
    }

    const hasChanges = staged.length > 0 || unstaged.length > 0 || untracked.length > 0;
    const isClean = !hasChanges;

    return {
      branch,
      ahead: trackingStatus.ahead,
      behind: trackingStatus.behind,
      staged,
      unstaged,
      untracked,
      hasChanges,
      isClean,
    };
  }

  /**
   * Parse git status character to FileChangeStatus
   */
  private parseStatusChar(char: string): FileChangeStatus {
    switch (char) {
      case 'A': return 'added';
      case 'M': return 'modified';
      case 'D': return 'deleted';
      case 'R': return 'renamed';
      case 'C': return 'copied';
      case '?': return 'untracked';
      case '!': return 'ignored';
      default: return 'modified';
    }
  }

  // ============================================
  // Branch Operations
  // ============================================

  /**
   * Get current branch name
   */
  getCurrentBranch(): string | null {
    const result = this.execGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    return result?.trim() || null;
  }

  /**
   * Get tracking status (ahead/behind)
   */
  getTrackingStatus(): { ahead: number; behind: number } {
    const result = this.execGit(['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
    if (!result) {
      return { ahead: 0, behind: 0 };
    }

    const [behind, ahead] = result.trim().split('\t').map(Number);
    return { ahead: ahead || 0, behind: behind || 0 };
  }

  /**
   * Get list of branches
   */
  getBranches(): BranchInfo[] {
    const result = this.execGit([
      'branch', '-a', '--format=%(refname:short)|%(HEAD)|%(upstream:short)|%(upstream:track)'
    ]);

    if (!result) return [];

    return result.split('\n')
      .filter(Boolean)
      .map(line => {
        const [name, head, tracking, trackInfo] = line.split('|');
        const current = head === '*';

        let ahead = 0;
        let behind = 0;
        if (trackInfo) {
          const aheadMatch = trackInfo.match(/ahead (\d+)/);
          const behindMatch = trackInfo.match(/behind (\d+)/);
          if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
          if (behindMatch) behind = parseInt(behindMatch[1], 10);
        }

        return {
          name,
          current,
          tracking: tracking || undefined,
          ahead,
          behind,
        };
      });
  }

  // ============================================
  // Commit History
  // ============================================

  /**
   * Get recent commits
   */
  getRecentCommits(limit = 50): CommitInfo[] {
    const format = '%H|%h|%an|%ae|%aI|%s|%b%x00';
    const result = this.execGit(['log', `-${limit}`, `--format=${format}`]);

    if (!result) return [];

    return result.split('\x00')
      .filter(Boolean)
      .map(entry => {
        const lines = entry.trim().split('|');
        const [hash, shortHash, author, authorEmail, dateStr, message, ...bodyParts] = lines;

        return {
          hash,
          shortHash,
          author,
          authorEmail,
          date: new Date(dateStr),
          message,
          body: bodyParts.join('|').trim() || undefined,
        };
      });
  }

  /**
   * Get commit info by hash
   */
  getCommit(hash: string): CommitInfo | null {
    const format = '%H|%h|%an|%ae|%aI|%s|%b';
    const result = this.execGit(['show', '-s', `--format=${format}`, hash]);

    if (!result) return null;

    const lines = result.trim().split('|');
    const [commitHash, shortHash, author, authorEmail, dateStr, message, ...bodyParts] = lines;

    return {
      hash: commitHash,
      shortHash,
      author,
      authorEmail,
      date: new Date(dateStr),
      message,
      body: bodyParts.join('|').trim() || undefined,
    };
  }

  // ============================================
  // Diff Operations
  // ============================================

  /**
   * Get diff of staged changes
   */
  getStagedDiff(): DiffResult {
    const diffOutput = this.execGit(['diff', '--cached', '--unified=3']) || '';
    return this.parseDiff(diffOutput);
  }

  /**
   * Get diff of unstaged changes
   */
  getUnstagedDiff(): DiffResult {
    const diffOutput = this.execGit(['diff', '--unified=3']) || '';
    return this.parseDiff(diffOutput);
  }

  /**
   * Get diff between two refs (branches, commits, tags)
   */
  getDiffBetween(fromRef: string, toRef: string): DiffResult {
    const diffOutput = this.execGit(['diff', `${fromRef}...${toRef}`, '--unified=3']) || '';
    return this.parseDiff(diffOutput);
  }

  /**
   * Get diff for a specific file
   */
  getFileDiff(filePath: string, staged = false): DiffResult {
    const args = staged
      ? ['diff', '--cached', '--unified=3', '--', filePath]
      : ['diff', '--unified=3', '--', filePath];
    const diffOutput = this.execGit(args) || '';
    return this.parseDiff(diffOutput);
  }

  /**
   * Get diff stats (summary)
   */
  getDiffStats(staged = false): DiffStats {
    const args = staged
      ? ['diff', '--cached', '--stat', '--numstat']
      : ['diff', '--stat', '--numstat'];
    const result = this.execGit(args) || '';

    let insertions = 0;
    let deletions = 0;
    let filesChanged = 0;

    const lines = result.split('\n');
    for (const line of lines) {
      const match = line.match(/^(\d+)\t(\d+)\t/);
      if (match) {
        insertions += parseInt(match[1], 10) || 0;
        deletions += parseInt(match[2], 10) || 0;
        filesChanged++;
      }
    }

    return { filesChanged, insertions, deletions };
  }

  /**
   * Parse unified diff output
   */
  private parseDiff(diffOutput: string): DiffResult {
    const files: DiffFile[] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;

    if (!diffOutput.trim()) {
      return { files, totalAdditions, totalDeletions };
    }

    // Split by file headers
    const fileChunks = diffOutput.split(/^diff --git /m).filter(Boolean);

    for (const chunk of fileChunks) {
      const lines = chunk.split('\n');
      const headerLine = lines[0] || '';

      // Parse file paths from header: a/path b/path
      const pathMatch = headerLine.match(/a\/(.+?) b\/(.+?)$/);
      if (!pathMatch) continue;

      const oldPath = pathMatch[1];
      const newPath = pathMatch[2];
      const isRename = oldPath !== newPath;

      // Determine status
      let status: FileChangeStatus = 'modified';
      for (const line of lines.slice(1, 5)) {
        if (line.startsWith('new file')) status = 'added';
        else if (line.startsWith('deleted file')) status = 'deleted';
        else if (line.startsWith('rename from')) status = 'renamed';
        else if (line.startsWith('copy from')) status = 'copied';
      }

      // Parse hunks
      const hunks: DiffHunk[] = [];
      let currentHunk: DiffHunk | null = null;
      let additions = 0;
      let deletions = 0;

      for (const line of lines) {
        // Hunk header: @@ -start,count +start,count @@
        const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (hunkMatch) {
          if (currentHunk) {
            hunks.push(currentHunk);
          }
          currentHunk = {
            oldStart: parseInt(hunkMatch[1], 10),
            oldLines: parseInt(hunkMatch[2] || '1', 10),
            newStart: parseInt(hunkMatch[3], 10),
            newLines: parseInt(hunkMatch[4] || '1', 10),
            content: line + '\n',
          };
        } else if (currentHunk) {
          currentHunk.content += line + '\n';
          if (line.startsWith('+') && !line.startsWith('+++')) {
            additions++;
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            deletions++;
          }
        }
      }

      if (currentHunk) {
        hunks.push(currentHunk);
      }

      files.push({
        path: newPath,
        oldPath: isRename ? oldPath : undefined,
        status,
        hunks,
        additions,
        deletions,
      });

      totalAdditions += additions;
      totalDeletions += deletions;
    }

    return { files, totalAdditions, totalDeletions };
  }

  // ============================================
  // File Operations
  // ============================================

  /**
   * Get file content at a specific commit
   */
  getFileAtCommit(filePath: string, commitHash: string): string | null {
    return this.execGit(['show', `${commitHash}:${filePath}`]);
  }

  /**
   * Get file history (commits that modified the file)
   */
  getFileHistory(filePath: string, limit = 20): CommitInfo[] {
    const format = '%H|%h|%an|%ae|%aI|%s%x00';
    const result = this.execGit(['log', `-${limit}`, `--format=${format}`, '--follow', '--', filePath]);

    if (!result) return [];

    return result.split('\x00')
      .filter(Boolean)
      .map(entry => {
        const [hash, shortHash, author, authorEmail, dateStr, message] = entry.trim().split('|');
        return {
          hash,
          shortHash,
          author,
          authorEmail,
          date: new Date(dateStr),
          message,
        };
      });
  }

  /**
   * Check if a file is tracked by git
   */
  isFileTracked(filePath: string): boolean {
    const result = this.execGit(['ls-files', '--', filePath]);
    return Boolean(result?.trim());
  }

  /**
   * Get blame information for a file
   */
  getBlame(filePath: string): Array<{ commit: string; author: string; date: string; line: string }> | null {
    const result = this.execGit(['blame', '--porcelain', '--', filePath]);
    if (!result) return null;

    const blameEntries: Array<{ commit: string; author: string; date: string; line: string }> = [];
    const lines = result.split('\n');

    let currentCommit = '';
    let currentAuthor = '';
    let currentDate = '';

    for (const line of lines) {
      if (line.match(/^[0-9a-f]{40}/)) {
        currentCommit = line.slice(0, 40);
      } else if (line.startsWith('author ')) {
        currentAuthor = line.slice(7);
      } else if (line.startsWith('author-time ')) {
        const timestamp = parseInt(line.slice(12), 10);
        currentDate = new Date(timestamp * 1000).toISOString();
      } else if (line.startsWith('\t')) {
        blameEntries.push({
          commit: currentCommit.slice(0, 8),
          author: currentAuthor,
          date: currentDate,
          line: line.slice(1),
        });
      }
    }

    return blameEntries;
  }

  // ============================================
  // Stash Operations
  // ============================================

  /**
   * List stashes
   */
  listStashes(): Array<{ index: number; message: string; branch: string }> {
    const result = this.execGit(['stash', 'list', '--format=%gd|%s|%gs']);
    if (!result) return [];

    return result.split('\n')
      .filter(Boolean)
      .map(line => {
        const [ref, message, desc] = line.split('|');
        const indexMatch = ref.match(/stash@\{(\d+)\}/);
        return {
          index: indexMatch ? parseInt(indexMatch[1], 10) : 0,
          message: message || desc || 'WIP',
          branch: desc?.match(/on (.+?):/)?.[1] || 'unknown',
        };
      });
  }

  // ============================================
  // Remote Operations
  // ============================================

  /**
   * Get list of remotes
   */
  getRemotes(): Array<{ name: string; url: string; type: 'fetch' | 'push' }> {
    const result = this.execGit(['remote', '-v']);
    if (!result) return [];

    return result.split('\n')
      .filter(Boolean)
      .map(line => {
        const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
        if (!match) return null;
        return {
          name: match[1],
          url: match[2],
          type: match[3] as 'fetch' | 'push',
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }

  /**
   * Get the default remote (usually 'origin')
   */
  getDefaultRemote(): string | null {
    const remotes = this.getRemotes();
    const origin = remotes.find(r => r.name === 'origin');
    return origin?.name || remotes[0]?.name || null;
  }
}

// ============================================
// Factory Function
// ============================================

/**
 * Create a VCS manager for a directory
 */
export function createVcsManager(workingDirectory: string): VcsManager {
  return new VcsManager(workingDirectory);
}

/**
 * Check if git is available on the system
 */
export function isGitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { encoding: 'utf-8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
