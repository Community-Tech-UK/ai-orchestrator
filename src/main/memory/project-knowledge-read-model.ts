import { getRLMDatabase } from '../persistence/rlm-database';
import type { SqliteDriver } from '../db/sqlite-driver';
import * as projectCodeIndexStore from '../persistence/rlm/rlm-project-code-index';
import * as projectKnowledgeStore from '../persistence/rlm/rlm-project-knowledge';
import { getProjectRootRegistry, type ProjectRootRegistry } from './project-root-registry';
import { normalizeProjectMemoryKey } from './project-memory-key';
import type {
  ProjectKnowledgeEvidence,
  ProjectKnowledgeFact,
  ProjectKnowledgeProjectSummary,
  ProjectKnowledgeReadModel,
  ProjectKnowledgeTargetKind,
  ProjectKnowledgeWakeHintItem,
} from '../../shared/types/knowledge-graph.types';

interface ProjectKnowledgeReadModelDeps {
  registry: Pick<ProjectRootRegistry, 'listRoots' | 'getRoot'>;
  db?: SqliteDriver;
}

interface FactRow {
  target_id: string;
  subject_name: string;
  predicate: string;
  object_name: string;
  confidence: number;
  valid_from: string | null;
  valid_to: string | null;
  source_file: string | null;
  evidence_count: number;
}

interface WakeHintItemRow {
  target_id: string;
  content: string;
  importance: number;
  room: string;
  created_at: number;
  evidence_count: number;
}

export class ProjectKnowledgeReadModelService {
  private static instance: ProjectKnowledgeReadModelService | null = null;

  static getInstance(): ProjectKnowledgeReadModelService {
    this.instance ??= new ProjectKnowledgeReadModelService();
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  constructor(
    private readonly deps: ProjectKnowledgeReadModelDeps = {
      registry: getProjectRootRegistry(),
    },
  ) {}

  listProjects(): ProjectKnowledgeProjectSummary[] {
    return this.deps.registry.listRoots().map((root) => ({
      projectKey: root.projectKey ?? root.normalizedPath,
      rootPath: root.rootPath ?? root.normalizedPath,
      displayName: root.displayName ?? root.normalizedPath,
      miningStatus: root,
      inventory: projectKnowledgeStore.getProjectKnowledgeSourceInventory(this.db, root.projectKey ?? root.normalizedPath),
    }));
  }

  getReadModel(projectKey: string): ProjectKnowledgeReadModel {
    const normalizedProjectKey = normalizeProjectMemoryKey(projectKey) || projectKey;
    const project = this.getProjectSummary(normalizedProjectKey);

    return {
      project,
      sources: projectKnowledgeStore.listProjectKnowledgeSources(this.db, normalizedProjectKey),
      facts: this.listFacts(normalizedProjectKey),
      wakeHints: this.listWakeHints(normalizedProjectKey),
      codeIndex: projectCodeIndexStore.getProjectCodeIndexStatus(this.db, normalizedProjectKey),
      codeSymbols: projectCodeIndexStore.listProjectCodeSymbols(this.db, normalizedProjectKey),
    };
  }

  getEvidence(
    projectKey: string,
    targetKind: ProjectKnowledgeTargetKind,
    targetId: string,
  ): ProjectKnowledgeEvidence[] {
    const normalizedProjectKey = normalizeProjectMemoryKey(projectKey) || projectKey;
    return projectKnowledgeStore.listProjectEvidenceForTarget(this.db, normalizedProjectKey, targetKind, targetId);
  }

  private getProjectSummary(projectKey: string): ProjectKnowledgeProjectSummary {
    const root = this.deps.registry.getRoot(projectKey);
    if (!root) {
      throw new Error(`Project is not registered: ${projectKey}`);
    }

    return {
      projectKey: root.projectKey ?? root.normalizedPath,
      rootPath: root.rootPath ?? root.normalizedPath,
      displayName: root.displayName ?? root.normalizedPath,
      miningStatus: root,
      inventory: projectKnowledgeStore.getProjectKnowledgeSourceInventory(this.db, root.projectKey ?? root.normalizedPath),
    };
  }

  private listFacts(projectKey: string): ProjectKnowledgeFact[] {
    const rows = this.db.prepare(`
      SELECT
        t.id as target_id,
        subject_entity.name as subject_name,
        t.predicate,
        object_entity.name as object_name,
        t.confidence,
        t.valid_from,
        t.valid_to,
        t.source_file,
        COUNT(l.id) as evidence_count
      FROM project_knowledge_kg_links l
      JOIN kg_triples t ON t.id = l.triple_id
      JOIN kg_entities subject_entity ON subject_entity.id = t.subject
      JOIN kg_entities object_entity ON object_entity.id = t.object
      WHERE l.project_key = ?
        AND t.valid_to IS NULL
      GROUP BY t.id
      ORDER BY subject_entity.name ASC, t.predicate ASC, object_entity.name ASC
    `).all(projectKey) as FactRow[];

    return rows.map((row) => ({
      targetKind: 'kg_triple',
      targetId: row.target_id,
      subject: row.subject_name,
      predicate: row.predicate,
      object: row.object_name,
      confidence: row.confidence,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      sourceFile: row.source_file,
      evidenceCount: row.evidence_count,
    }));
  }

  private listWakeHints(projectKey: string): ProjectKnowledgeWakeHintItem[] {
    const rows = this.db.prepare(`
      SELECT
        h.id as target_id,
        h.content,
        h.importance,
        h.room,
        h.created_at,
        COUNT(l.id) as evidence_count
      FROM project_knowledge_wake_links l
      JOIN wake_hints h ON h.id = l.hint_id
      WHERE l.project_key = ?
        AND h.room = ?
      GROUP BY h.id
      ORDER BY h.importance DESC, h.created_at DESC
    `).all(projectKey, projectKey) as WakeHintItemRow[];

    return rows.map((row) => ({
      targetKind: 'wake_hint',
      targetId: row.target_id,
      content: row.content,
      importance: row.importance,
      room: row.room,
      createdAt: row.created_at,
      evidenceCount: row.evidence_count,
    }));
  }

  private get db(): SqliteDriver {
    return this.deps.db ?? getRLMDatabase().getRawDb();
  }
}

export function getProjectKnowledgeReadModelService(): ProjectKnowledgeReadModelService {
  return ProjectKnowledgeReadModelService.getInstance();
}
