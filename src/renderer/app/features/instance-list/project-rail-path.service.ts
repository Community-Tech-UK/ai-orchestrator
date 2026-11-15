import { Injectable, inject } from '@angular/core';
import { ScratchDirectoryService } from '../../core/services/scratch-directory.service';
import {
  isPlanQueueWorktreePath,
  isWorktreePath,
  sessionProjectPath,
} from '../../../../shared/utils/worktree-project-path';
import {
  CHATS_KEY,
  NO_WORKSPACE_KEY,
} from './instance-list.types';

@Injectable({ providedIn: 'root' })
export class ProjectRailPathService {
  private scratchDirectory = inject(ScratchDirectoryService);

  /** The project directory a session belongs to; see `sessionProjectPath`. */
  getSessionProjectPath(workingDirectory: string | null | undefined): string | null | undefined {
    return sessionProjectPath(workingDirectory);
  }

  isWorktreePath(workingDirectory: string | null | undefined): boolean {
    return isWorktreePath(workingDirectory);
  }

  isPlanQueueWorktreePath(workingDirectory: string | null | undefined): boolean {
    return isPlanQueueWorktreePath(workingDirectory);
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
