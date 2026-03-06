import type { ConversationEndStatus } from './history.types';
import type { OutputMessage } from './instance.types';
import type { ArtifactSeverity, ArtifactType } from './child-result.types';

export interface SessionShareBundleSource {
  kind: 'instance' | 'history';
  instanceId?: string;
  historyEntryId?: string;
  displayName: string;
  workingDirectoryLabel: string;
  createdAt?: number;
  endedAt?: number;
  status?: ConversationEndStatus | 'active';
}

export interface SessionShareSnapshotSummary {
  id: string;
  timestamp: number;
  name?: string;
  description?: string;
  trigger: 'auto' | 'manual' | 'checkpoint';
  messageCount: number;
  tokensUsed: number;
}

export interface SessionShareFileSnapshotSession {
  id: string;
  startedAt: number;
  endedAt?: number;
  description?: string;
  fileCount: number;
  snapshotCount: number;
}

export interface SessionShareArtifact {
  id: string;
  source: 'child-result' | 'evidence';
  type: ArtifactType | 'browser-evidence';
  timestamp?: number;
  severity?: ArtifactSeverity;
  title: string;
  content: string;
  fileLabel?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionShareAttachment {
  id: string;
  kind: 'image' | 'json' | 'text' | 'trace' | 'other';
  timestamp?: number;
  title: string;
  sourcePathLabel?: string;
  fileName?: string;
  mediaType?: string;
  size?: number;
  embeddedText?: string;
  embeddedBase64?: string;
}

export interface SessionShareBundleSummary {
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;
  toolMessages: number;
  artifactCount: number;
  attachmentCount: number;
  continuitySnapshotCount: number;
  fileSnapshotSessionCount: number;
  redactedContentCount: number;
}

export interface SessionShareBundle {
  version: '1.0';
  createdAt: number;
  redacted: true;
  source: SessionShareBundleSource;
  summary: SessionShareBundleSummary;
  messages: OutputMessage[];
  artifacts: SessionShareArtifact[];
  attachments: SessionShareAttachment[];
  continuitySnapshots: SessionShareSnapshotSummary[];
  fileSnapshotSessions: SessionShareFileSnapshotSession[];
  warnings: string[];
}
