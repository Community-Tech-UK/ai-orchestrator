import type { OutputMessage } from './instance.types';
import type { RepoJobRecord } from './repo-job.types';
import type { SessionShareBundle } from './session-share.types';
import type { WorkerNodeInfo } from './worker-node.types';

export interface RemoteObserverPrompt {
  id: string;
  promptType: 'input-required' | 'user-action';
  instanceId?: string;
  requestId?: string;
  createdAt: number;
  title: string;
  message: string;
  options?: string[];
}

export interface RemoteObserverInstanceSummary {
  id: string;
  displayName: string;
  status: string;
  provider?: string;
  model?: string;
  createdAt: number;
  lastActivity: number;
  workingDirectoryLabel: string;
}

export interface RemoteObserverStatus {
  running: boolean;
  mode: 'read-only';
  host: string;
  port?: number;
  token?: string;
  startedAt?: number;
  observerUrls: string[];
  instanceCount: number;
  jobCount: number;
  pendingPromptCount: number;
  lastEventAt?: number;
}

export interface RemoteObserverSnapshot {
  status: RemoteObserverStatus;
  instances: RemoteObserverInstanceSummary[];
  jobs: RepoJobRecord[];
  pendingPrompts: RemoteObserverPrompt[];
  workerNodes?: WorkerNodeInfo[];
}

export type RemoteObserverEventType =
  | 'instance-output'
  | 'instance-state'
  | 'repo-job'
  | 'permission-prompt'
  | 'status';

export interface RemoteObserverEventEnvelope {
  id: string;
  type: RemoteObserverEventType;
  timestamp: number;
  data:
    | OutputMessage
    | SessionShareBundle
    | RepoJobRecord
    | RemoteObserverPrompt
    | RemoteObserverSnapshot
    | Record<string, unknown>;
}
