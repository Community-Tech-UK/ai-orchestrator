import * as crypto from 'crypto';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getRLMDatabase } from '../persistence/rlm-database';
import * as projectKnowledgeStore from '../persistence/rlm/rlm-project-knowledge';
import { normalizeProjectMemoryKey } from '../memory/project-memory-key';
import type {
  OperatorProjectRecord,
  OperatorRunGraph,
} from '../../shared/types/operator.types';

export interface OperatorMemoryPromotionInput {
  graph: OperatorRunGraph;
  projects: OperatorProjectRecord[];
}

export interface OperatorMemoryPromotionResult {
  projectId: string;
  projectKey: string;
  sourceId: string;
  hintId: string;
  sourceCreated: boolean;
  sourceChanged: boolean;
  linkCreated: boolean;
}

export interface OperatorMemoryPromoterConfig {
  db?: SqliteDriver;
  now?: () => number;
}

export class OperatorMemoryPromoter {
  private readonly now: () => number;

  constructor(private readonly config: OperatorMemoryPromoterConfig = {}) {
    this.now = config.now ?? Date.now;
  }

  promote(input: OperatorMemoryPromotionInput): OperatorMemoryPromotionResult[] {
    if (input.graph.run.status !== 'completed') {
      return [];
    }

    const summary = readSynthesisSummary(input.graph);
    if (!summary) {
      return [];
    }

    const projects = uniqueProjects(input.projects);
    if (projects.length === 0) {
      return [];
    }

    return this.db.transaction(() => projects.map((project) => (
      this.promoteProject(input.graph, project, summary)
    )))();
  }

  private promoteProject(
    graph: OperatorRunGraph,
    project: OperatorProjectRecord,
    summary: string,
  ): OperatorMemoryPromotionResult {
    const projectKey = normalizeProjectMemoryKey(project.canonicalPath) || project.canonicalPath;
    const sourceUri = `operator://runs/${graph.run.id}/projects/${project.id}`;
    const sourceContent = JSON.stringify({
      runId: graph.run.id,
      projectId: project.id,
      projectPath: project.canonicalPath,
      status: graph.run.status,
      goal: graph.run.goal,
      result: graph.run.resultJson,
    });
    const upsert = projectKnowledgeStore.upsertProjectKnowledgeSource(this.db, {
      projectKey,
      sourceKind: 'operator_result',
      sourceUri,
      sourceTitle: graph.run.title,
      contentFingerprint: sha256(sourceContent),
      metadata: {
        operatorRunId: graph.run.id,
        operatorThreadId: graph.run.threadId,
        operatorSourceMessageId: graph.run.sourceMessageId,
        projectId: project.id,
        projectPath: project.canonicalPath,
        completedAt: graph.run.completedAt,
      },
    });
    const hintId = this.upsertWakeHint({
      id: stableId('operator_hint', graph.run.id, project.id),
      content: buildHintContent(graph, project, summary),
      room: projectKey,
      sourceSessionId: graph.run.threadId,
    });
    const link = projectKnowledgeStore.linkProjectKnowledgeWakeHint(this.db, {
      projectKey,
      sourceId: upsert.source.id,
      hintId,
      evidenceStrength: 0.9,
      metadata: {
        evidenceKind: 'operator_result_summary',
        operatorRunId: graph.run.id,
        projectId: project.id,
      },
    });

    return {
      projectId: project.id,
      projectKey,
      sourceId: upsert.source.id,
      hintId,
      sourceCreated: upsert.created,
      sourceChanged: upsert.changed,
      linkCreated: link.created,
    };
  }

  private upsertWakeHint(input: {
    id: string;
    content: string;
    room: string;
    sourceSessionId: string;
  }): string {
    const now = this.now();
    this.db.prepare(`
      INSERT INTO wake_hints (
        id, content, importance, room, source_reflection_id,
        source_session_id, created_at, last_used, usage_count
      )
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        importance = excluded.importance,
        room = excluded.room,
        source_session_id = excluded.source_session_id,
        last_used = excluded.last_used
    `).run(
      input.id,
      input.content,
      8,
      input.room,
      input.sourceSessionId,
      now,
      now,
    );
    return input.id;
  }

  private get db(): SqliteDriver {
    return this.config.db ?? getRLMDatabase().getRawDb();
  }
}

export function getOperatorMemoryPromoter(): OperatorMemoryPromoter {
  return new OperatorMemoryPromoter();
}

function readSynthesisSummary(graph: OperatorRunGraph): string | null {
  const synthesis = asRecord(graph.run.resultJson?.['synthesis']);
  const summaryMarkdown = typeof synthesis?.['summaryMarkdown'] === 'string'
    ? synthesis['summaryMarkdown'].trim()
    : '';
  if (summaryMarkdown) {
    return summaryMarkdown;
  }

  const completedWork = readStringArray(synthesis?.['completedWork']);
  if (completedWork.length > 0) {
    return completedWork.join('\n');
  }

  return null;
}

function buildHintContent(
  graph: OperatorRunGraph,
  project: OperatorProjectRecord,
  summary: string,
): string {
  return truncateText([
    `Operator completed "${graph.run.title}" for ${project.displayName}.`,
    `Goal: ${graph.run.goal}`,
    summary,
  ].join('\n'), 900);
}

function uniqueProjects(projects: OperatorProjectRecord[]): OperatorProjectRecord[] {
  const seen = new Set<string>();
  const unique: OperatorProjectRecord[] = [];
  for (const project of projects) {
    const key = project.id || project.canonicalPath;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(project);
  }
  return unique;
}

function stableId(prefix: string, ...parts: string[]): string {
  const hash = sha256(parts.join('\0')).slice(0, 24);
  return `${prefix}_${hash}`;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function truncateText(value: string, maxLength: number): string {
  const trimmed = value.trim().replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return trimmed.length > maxLength
    ? `${trimmed.slice(0, maxLength - 3).trimEnd()}...`
    : trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}
