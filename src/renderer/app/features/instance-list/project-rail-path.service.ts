import { Injectable, inject } from '@angular/core';
import { ScratchDirectoryService } from '../../core/services/scratch-directory.service';
import {
  CHATS_KEY,
  NO_WORKSPACE_KEY,
} from './instance-list.types';

/** A `.worktrees` directory segment, as created for Plan Queue items, loops and AIO-managed worktrees. */
const WORKTREES_SEGMENT = /[\\/]\.worktrees(?:[\\/]|$)/;
/** A Plan Queue item's worktree (`<repo>/.worktrees/queue/<item>`, see plan-queue-worktree.ts). */
const PLAN_QUEUE_WORKTREE = /[\\/]\.worktrees[\\/]queue[\\/]/;

@Injectable({ providedIn: 'root' })
export class ProjectRailPathService {
  private scratchDirectory = inject(ScratchDirectoryService);

  /**
   * The project directory a session belongs to. A session working inside a
   * repository's `.worktrees/` checkout belongs to that repository's project;
   * without this, every Plan Queue item or loop worktree became a project of
   * its own in the rail.
   */
  getSessionProjectPath(workingDirectory: string | null | undefined): string | null | undefined {
    const normalized = workingDirectory?.trim() ?? '';
    const match = WORKTREES_SEGMENT.exec(normalized);
    return match && match.index > 0 ? normalized.slice(0, match.index) : workingDirectory;
  }

  isWorktreePath(workingDirectory: string | null | undefined): boolean {
    return this.getSessionProjectPath(workingDirectory) !== workingDirectory;
  }

  isPlanQueueWorktreePath(workingDirectory: string | null | undefined): boolean {
    return PLAN_QUEUE_WORKTREE.test(workingDirectory ?? '');
  }

  getProjectKey(workingDirectory: string | null | undefined): string {
    if (this.scratchDirectory.isScratch(workingDirectory)) {
      return CHATS_KEY;
    }
    const normalized = (workingDirectory ?? '').trim();
    return normalized ? normalized.toLowerCase() : NO_WORKSPACE_KEY;
  }

  getProjectTitle(workingDirectory: string | null | undefined): string {
    if (this.scratchDirectory.isScratch(workingDirectory)) {
      return 'Chats';
    }
    const normalized = (workingDirectory ?? '').trim();
    if (!normalized) {
      return 'No workspace';
    }

    const parts = normalized.split(/[/\\]/).filter(Boolean);
    return parts.at(-1) ?? normalized;
  }

  getProjectSubtitle(workingDirectory: string | null | undefined): string {
    if (this.scratchDirectory.isScratch(workingDirectory)) {
      return 'General chats';
    }
    const normalized = (workingDirectory ?? '').trim();
    if (!normalized) {
      return 'Sessions without a working directory';
    }

    return normalized
      .replace(/^\/Users\/[^/]+/, '~')
      .replace(/^\/home\/[^/]+/, '~');
  }
}
