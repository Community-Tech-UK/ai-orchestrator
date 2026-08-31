import type { InstanceProvider } from './instance.types';

export type SessionRecoveryReason =
  | 'newer-than-history'
  | 'unarchived'
  | 'draft-only';

export interface SessionRecoveryCandidate {
  recoveryKey: string;
  sourceInstanceId: string;
  historyThreadId?: string;
  provider: InstanceProvider;
  modelId?: string;
  displayName?: string;
  workingDirectory?: string;
  lastActivityAt: number;
  historyCoveredThrough?: number;
  recoveredMessageCount: number;
  reason: SessionRecoveryReason;
  nativeResumeAvailable: boolean;
}

export interface RecoverSessionRequest {
  recoveryKey: string;
}

export interface RecoverSessionResult {
  instanceId: string;
  recoveredMessageCount: number;
  usedNativeResume: boolean;
}
