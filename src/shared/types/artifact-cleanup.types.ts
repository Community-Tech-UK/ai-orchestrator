export type ArtifactOwnerType =
  | 'child_result'
  | 'automation_run'
  | 'webhook_delivery'
  | 'session'
  | 'instance'
  | 'worktree'
  | 'diagnostic_bundle';

export interface ArtifactRegistryRecord {
  id: string;
  ownerType: ArtifactOwnerType;
  ownerId: string;
  kind: string;
  path: string;
  protected: boolean;
  metadata?: Record<string, unknown>;
  createdAt: number;
  lastSeenAt: number;
}

export interface ArtifactCleanupCandidate {
  artifact: ArtifactRegistryRecord;
  reason: string;
  wouldRemove: boolean;
  blockedReason?: string;
}

export interface ArtifactCleanupResult {
  dryRun: boolean;
  candidates: ArtifactCleanupCandidate[];
  removed: string[];
  errors: Array<{ artifactId: string; error: string }>;
}
