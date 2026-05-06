/**
 * Knowledge Graph Types
 * Temporal entity-relationship storage inspired by mempalace's knowledge_graph.py
 *
 * Core Concepts:
 * - Entities: named things (people, projects, concepts)
 * - Triples: (subject, predicate, object) relationships with temporal validity
 * - Temporal validity: facts have valid_from/valid_to windows, enabling "what was true at time T?"
 */

export type KGEntityType = 'person' | 'project' | 'concept' | 'place' | 'unknown';

export interface KGEntity {
  id: string;
  name: string;
  type: KGEntityType;
  properties: Record<string, unknown>;
  createdAt: number;
}

export interface KGTriple {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  validFrom: string | null;
  validTo: string | null;
  confidence: number;
  sourceCloset: string | null;
  sourceFile: string | null;
  extractedAt: number;
}

export type KGDirection = 'outgoing' | 'incoming' | 'both';

export interface KGEntityQuery {
  entityName: string;
  asOf?: string;
  direction?: KGDirection;
}

export interface KGRelationshipQuery {
  predicate: string;
  asOf?: string;
}

export interface KGTimelineQuery {
  entityName?: string;
  limit?: number;
}

export interface KGQueryResult {
  id: string;
  direction: KGDirection;
  subject: string;
  predicate: string;
  object: string;
  validFrom: string | null;
  validTo: string | null;
  confidence: number;
  sourceCloset: string | null;
  sourceFile: string | null;
  current: boolean;
}

export interface KGStats {
  entities: number;
  triples: number;
  currentFacts: number;
  expiredFacts: number;
  relationshipTypes: string[];
}

export type CodebaseMiningRunStatus = 'never' | 'running' | 'completed' | 'failed';

export type ProjectDiscoverySource =
  | 'manual'
  | 'manual-browse'
  | 'default-working-directory'
  | 'instance-working-directory';

export interface CodebaseMiningFileSnapshot {
  relativePath: string;
  hash: string;
  size: number;
}

export interface CodebaseMiningStatus {
  normalizedPath: string;
  rootPath?: string;
  projectKey?: string;
  displayName?: string;
  discoverySource?: ProjectDiscoverySource;
  autoMine?: boolean;
  isPaused?: boolean;
  isExcluded?: boolean;
  mined: boolean;
  status: CodebaseMiningRunStatus;
  contentFingerprint?: string;
  filesRead?: number;
  factsExtracted?: number;
  hintsCreated?: number;
  errors?: string[];
  startedAt?: number;
  completedAt?: number;
  lastActiveAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface CodebaseMiningResult {
  normalizedPath: string;
  rootPath?: string;
  projectKey?: string;
  displayName?: string;
  discoverySource?: ProjectDiscoverySource;
  autoMine?: boolean;
  isPaused?: boolean;
  isExcluded?: boolean;
  status: CodebaseMiningRunStatus;
  factsExtracted: number;
  hintsCreated: number;
  filesRead: number;
  errors: string[];
  skipped?: boolean;
  skipReason?: 'unchanged' | 'in-flight' | 'paused' | 'excluded';
  contentFingerprint?: string;
  lastMinedAt?: number;
  sourcesProcessed?: number;
  sourcesCreated?: number;
  sourcesChanged?: number;
  sourcesDeleted?: number;
  sourceLinksCreated?: number;
  sourceLinksPruned?: number;
}

export type ProjectKnowledgeSourceKind =
  | 'manifest'
  | 'readme'
  | 'instruction_doc'
  | 'config'
  | 'code_file'
  | 'operator_result';

export type ProjectKnowledgeTargetKind = 'kg_triple' | 'wake_hint' | 'code_symbol';

export type ProjectSourceSpan =
  | {
      kind: 'file_lines';
      path: string;
      startLine: number;
      endLine: number;
      startColumn?: number;
      endColumn?: number;
    }
  | { kind: 'whole_source' };

export interface ProjectKnowledgeSource {
  id: string;
  projectKey: string;
  sourceKind: ProjectKnowledgeSourceKind;
  sourceUri: string;
  sourceTitle?: string;
  contentFingerprint: string;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  metadata: Record<string, unknown>;
}

export interface ProjectKnowledgeSourceDescriptor {
  sourceKind: ProjectKnowledgeSourceKind;
  sourceUri: string;
  contentFingerprint: string;
}

export interface ProjectKnowledgeSourceUpsertResult {
  source: ProjectKnowledgeSource;
  created: boolean;
  changed: boolean;
}

export interface ProjectKnowledgeSourceLink {
  id: string;
  projectKey: string;
  sourceId: string;
  targetKind: ProjectKnowledgeTargetKind;
  targetId: string;
  sourceSpan: ProjectSourceSpan;
  evidenceStrength: number;
  createdAt: number;
  metadata: Record<string, unknown>;
}

export interface ProjectKnowledgeSourceLinkResult {
  link: ProjectKnowledgeSourceLink;
  created: boolean;
}

export interface ProjectKnowledgeEvidence {
  link: ProjectKnowledgeSourceLink;
  source: ProjectKnowledgeSource;
}

export type ProjectCodeIndexRunStatus =
  | 'never'
  | 'indexing'
  | 'ready'
  | 'failed'
  | 'disabled'
  | 'paused'
  | 'excluded';

export interface ProjectCodeIndexStatus {
  projectKey: string;
  workspaceHash?: string;
  status: ProjectCodeIndexRunStatus;
  fileCount: number;
  symbolCount: number;
  syncStartedAt?: number;
  lastIndexedAt?: number;
  lastSyncedAt?: number;
  updatedAt: number;
  error?: string;
  metadata: Record<string, unknown>;
}

export interface ProjectCodeSymbol {
  targetKind: 'code_symbol';
  targetId: string;
  id: string;
  projectKey: string;
  sourceId: string;
  workspaceHash: string;
  symbolId: string;
  pathFromRoot: string;
  name: string;
  kind: string;
  containerName?: string;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  signature?: string;
  docComment?: string;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
  evidenceCount: number;
}

export interface ProjectKnowledgeSourceInventory {
  totalSources: number;
  totalLinks: number;
  totalKgLinks: number;
  totalWakeLinks: number;
  totalCodeSymbols: number;
  byKind: Partial<Record<ProjectKnowledgeSourceKind, number>>;
}

export interface ProjectKnowledgeProjectSummary {
  projectKey: string;
  rootPath: string;
  displayName: string;
  miningStatus: CodebaseMiningStatus;
  inventory: ProjectKnowledgeSourceInventory;
}

export interface ProjectKnowledgeFact {
  targetKind: 'kg_triple';
  targetId: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  validFrom: string | null;
  validTo: string | null;
  sourceFile: string | null;
  evidenceCount: number;
}

export interface ProjectKnowledgeWakeHintItem {
  targetKind: 'wake_hint';
  targetId: string;
  content: string;
  importance: number;
  room: string;
  createdAt: number;
  evidenceCount: number;
}

export interface ProjectKnowledgeReadModel {
  project: ProjectKnowledgeProjectSummary;
  sources: ProjectKnowledgeSource[];
  facts: ProjectKnowledgeFact[];
  wakeHints: ProjectKnowledgeWakeHintItem[];
  codeIndex: ProjectCodeIndexStatus;
  codeSymbols: ProjectCodeSymbol[];
}

export interface ProjectKnowledgeListProjectsResult {
  projects: ProjectKnowledgeProjectSummary[];
}

export interface ProjectKnowledgeReadModelRequest {
  projectKey: string;
}

export interface ProjectKnowledgeEvidenceRequest {
  projectKey: string;
  targetKind: ProjectKnowledgeTargetKind;
  targetId: string;
}

export interface ProjectCodeIndexRefreshRequest {
  projectKey: string;
}

export interface KnowledgeGraphConfig {
  maxEntities: number;
  maxTriples: number;
  timelineLimit: number;
  enableAutoExtraction: boolean;
}

export const DEFAULT_KG_CONFIG: KnowledgeGraphConfig = {
  maxEntities: 10_000,
  maxTriples: 50_000,
  timelineLimit: 100,
  enableAutoExtraction: true,
};
