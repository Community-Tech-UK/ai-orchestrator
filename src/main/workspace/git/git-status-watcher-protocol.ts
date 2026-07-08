export type StatusChangeReason =
  | 'index'
  | 'head'
  | 'refs'
  | 'remotes'
  | 'packed-refs'
  | 'worktree';

export interface GitStatusChangedEvent {
  repoPath: string;
  reason: StatusChangeReason;
  timestamp: number;
}

export type GitStatusWatcherWorkerInboundMsg =
  | {
      type: 'set-repos';
      id: number;
      repoPaths: string[];
    }
  | {
      type: 'shutdown';
      id: number;
    };

export type GitStatusWatcherWorkerOutboundMsg =
  | {
      type: 'response';
      id: number;
      ok: true;
      watchedRepos: string[];
    }
  | {
      type: 'response';
      id: number;
      ok: false;
      error: string;
    }
  | {
      type: 'status-changed';
      event: GitStatusChangedEvent;
    };
