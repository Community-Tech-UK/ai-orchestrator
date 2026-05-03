import * as crypto from 'crypto';
import type { SqliteDriver } from '../../db/sqlite-driver';
import type {
  ProjectCodeSymbolRow,
  ProjectKnowledgeKgLinkRow,
  ProjectKnowledgeSourceRow,
  ProjectKnowledgeWakeLinkRow,
} from '../rlm-database.types';
import { projectCodeSymbolEvidenceId } from './rlm-project-code-index';
import type {
  ProjectKnowledgeEvidence,
  ProjectKnowledgeSource,
  ProjectKnowledgeSourceDescriptor,
  ProjectKnowledgeSourceInventory,
  ProjectKnowledgeSourceKind,
  ProjectKnowledgeSourceLink,
  ProjectKnowledgeSourceLinkResult,
  ProjectKnowledgeSourceUpsertResult,
  ProjectKnowledgeTargetKind,
  ProjectSourceSpan,
} from '../../../shared/types/knowledge-graph.types';

interface UpsertSourceParams {
  projectKey: string;
  sourceKind: ProjectKnowledgeSourceKind;
  sourceUri: string;
  sourceTitle?: string;
  contentFingerprint: string;
  metadata?: Record<string, unknown>;
}

interface LinkKgTripleParams {
  projectKey: string;
  sourceId: string;
  tripleId: string;
  sourceSpan?: ProjectSourceSpan;
  evidenceStrength?: number;
  metadata?: Record<string, unknown>;
}

interface LinkWakeHintParams {
  projectKey: string;
  sourceId: string;
  hintId: string;
  sourceSpan?: ProjectSourceSpan;
  evidenceStrength?: number;
  metadata?: Record<string, unknown>;
}

const DEFAULT_SOURCE_SPAN: ProjectSourceSpan = { kind: 'whole_source' };

export function upsertProjectKnowledgeSource(
  db: SqliteDriver,
  params: UpsertSourceParams,
): ProjectKnowledgeSourceUpsertResult {
  const existing = db.prepare(`
    SELECT * FROM project_knowledge_sources
    WHERE project_key = ? AND source_uri = ?
  `).get(params.projectKey, params.sourceUri) as ProjectKnowledgeSourceRow | undefined;

  const now = Date.now();
  const metadataJson = JSON.stringify(params.metadata ?? {});

  if (!existing) {
    const id = stableId('pks', params.projectKey, params.sourceUri);
    db.prepare(`
      INSERT INTO project_knowledge_sources (
        id, project_key, source_kind, source_uri, source_title, content_fingerprint,
        created_at, updated_at, last_seen_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.projectKey,
      params.sourceKind,
      params.sourceUri,
      params.sourceTitle ?? null,
      params.contentFingerprint,
      now,
      now,
      now,
      metadataJson,
    );

    return {
      source: rowToSource(mustGetSource(db, id)),
      created: true,
      changed: false,
    };
  }

  const changed = existing.content_fingerprint !== params.contentFingerprint;
  db.prepare(`
    UPDATE project_knowledge_sources
    SET source_kind = ?,
        source_title = ?,
        content_fingerprint = ?,
        updated_at = ?,
        last_seen_at = ?,
        metadata_json = ?
    WHERE id = ?
  `).run(
    params.sourceKind,
    params.sourceTitle ?? null,
    params.contentFingerprint,
    now,
    now,
    metadataJson,
    existing.id,
  );

  return {
    source: rowToSource(mustGetSource(db, existing.id)),
    created: false,
    changed,
  };
}

export function deleteProjectKnowledgeSourcesNotSeen(
  db: SqliteDriver,
  projectKey: string,
  sourceUris: string[],
): number {
  if (sourceUris.length === 0) {
    return db.prepare(`
      DELETE FROM project_knowledge_sources
      WHERE project_key = ?
    `).run(projectKey).changes;
  }

  const placeholders = sourceUris.map(() => '?').join(', ');
  return db.prepare(`
    DELETE FROM project_knowledge_sources
    WHERE project_key = ?
      AND source_uri NOT IN (${placeholders})
  `).run(projectKey, ...sourceUris).changes;
}

export function deleteProjectKnowledgeSourcesByKindNotSeen(
  db: SqliteDriver,
  projectKey: string,
  sourceKind: ProjectKnowledgeSourceKind,
  sourceUris: string[],
): number {
  if (sourceUris.length === 0) {
    return db.prepare(`
      DELETE FROM project_knowledge_sources
      WHERE project_key = ? AND source_kind = ?
    `).run(projectKey, sourceKind).changes;
  }

  const placeholders = sourceUris.map(() => '?').join(', ');
  return db.prepare(`
    DELETE FROM project_knowledge_sources
    WHERE project_key = ?
      AND source_kind = ?
      AND source_uri NOT IN (${placeholders})
  `).run(projectKey, sourceKind, ...sourceUris).changes;
}

export function clearProjectKnowledgeLinksForSource(
  db: SqliteDriver,
  projectKey: string,
  sourceId: string,
  targetKinds: ProjectKnowledgeTargetKind[],
): number {
  const kinds = new Set(targetKinds);
  let changes = 0;

  if (kinds.has('kg_triple')) {
    changes += db.prepare(`
      DELETE FROM project_knowledge_kg_links
      WHERE project_key = ? AND source_id = ?
    `).run(projectKey, sourceId).changes;
  }

  if (kinds.has('wake_hint')) {
    changes += db.prepare(`
      DELETE FROM project_knowledge_wake_links
      WHERE project_key = ? AND source_id = ?
    `).run(projectKey, sourceId).changes;
  }

  return changes;
}

export function linkProjectKnowledgeKgTriple(
  db: SqliteDriver,
  params: LinkKgTripleParams,
): ProjectKnowledgeSourceLinkResult {
  assertSourceBelongsToProject(db, params.sourceId, params.projectKey);
  const id = stableId('pkgl', params.projectKey, params.sourceId, params.tripleId);
  const sourceSpan = params.sourceSpan ?? DEFAULT_SOURCE_SPAN;
  const createdAt = Date.now();

  const result = db.prepare(`
    INSERT INTO project_knowledge_kg_links (
      id, project_key, source_id, triple_id, source_span_json,
      evidence_strength, created_at, metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_key, source_id, triple_id) DO NOTHING
  `).run(
    id,
    params.projectKey,
    params.sourceId,
    params.tripleId,
    JSON.stringify(sourceSpan),
    params.evidenceStrength ?? 1,
    createdAt,
    JSON.stringify(params.metadata ?? {}),
  );

  const row = db.prepare(`
    SELECT * FROM project_knowledge_kg_links
    WHERE project_key = ? AND source_id = ? AND triple_id = ?
  `).get(params.projectKey, params.sourceId, params.tripleId) as ProjectKnowledgeKgLinkRow | undefined;

  if (!row) {
    throw new Error(`Failed to link project knowledge KG triple: ${params.tripleId}`);
  }

  return {
    link: kgLinkRowToLink(row),
    created: result.changes > 0,
  };
}

export function linkProjectKnowledgeWakeHint(
  db: SqliteDriver,
  params: LinkWakeHintParams,
): ProjectKnowledgeSourceLinkResult {
  assertSourceBelongsToProject(db, params.sourceId, params.projectKey);
  const id = stableId('pkwl', params.projectKey, params.sourceId, params.hintId);
  const sourceSpan = params.sourceSpan ?? DEFAULT_SOURCE_SPAN;
  const createdAt = Date.now();

  const result = db.prepare(`
    INSERT INTO project_knowledge_wake_links (
      id, project_key, source_id, hint_id, source_span_json,
      evidence_strength, created_at, metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_key, source_id, hint_id) DO NOTHING
  `).run(
    id,
    params.projectKey,
    params.sourceId,
    params.hintId,
    JSON.stringify(sourceSpan),
    params.evidenceStrength ?? 1,
    createdAt,
    JSON.stringify(params.metadata ?? {}),
  );

  const row = db.prepare(`
    SELECT * FROM project_knowledge_wake_links
    WHERE project_key = ? AND source_id = ? AND hint_id = ?
  `).get(params.projectKey, params.sourceId, params.hintId) as ProjectKnowledgeWakeLinkRow | undefined;

  if (!row) {
    throw new Error(`Failed to link project knowledge wake hint: ${params.hintId}`);
  }

  return {
    link: wakeLinkRowToLink(row),
    created: result.changes > 0,
  };
}

export function hasCurrentProjectKnowledgeSources(
  db: SqliteDriver,
  projectKey: string,
  sources: ProjectKnowledgeSourceDescriptor[],
): boolean {
  for (const source of sources) {
    const row = db.prepare(`
      SELECT source_kind, content_fingerprint FROM project_knowledge_sources
      WHERE project_key = ? AND source_uri = ?
    `).get(projectKey, source.sourceUri) as { source_kind: string; content_fingerprint: string } | undefined;

    if (!row || row.source_kind !== source.sourceKind || row.content_fingerprint !== source.contentFingerprint) {
      return false;
    }
  }

  return true;
}

export function listProjectKnowledgeSources(
  db: SqliteDriver,
  projectKey: string,
): ProjectKnowledgeSource[] {
  const rows = db.prepare(`
    SELECT * FROM project_knowledge_sources
    WHERE project_key = ?
    ORDER BY source_kind ASC, source_uri ASC
  `).all(projectKey) as ProjectKnowledgeSourceRow[];

  return rows.map(rowToSource);
}

export function listProjectKnowledgeLinks(
  db: SqliteDriver,
  projectKey: string,
): ProjectKnowledgeSourceLink[] {
  const kgRows = db.prepare(`
    SELECT * FROM project_knowledge_kg_links
    WHERE project_key = ?
  `).all(projectKey) as ProjectKnowledgeKgLinkRow[];
  const wakeRows = db.prepare(`
    SELECT * FROM project_knowledge_wake_links
    WHERE project_key = ?
  `).all(projectKey) as ProjectKnowledgeWakeLinkRow[];

  return [
    ...kgRows.map(kgLinkRowToLink),
    ...wakeRows.map(wakeLinkRowToLink),
  ].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

export function listProjectEvidenceForTarget(
  db: SqliteDriver,
  projectKey: string,
  targetKind: ProjectKnowledgeTargetKind,
  targetId: string,
): ProjectKnowledgeEvidence[] {
  if (targetKind === 'kg_triple') {
    const rows = db.prepare(`
      SELECT
        l.id as link_id, l.project_key as link_project_key, l.source_id as link_source_id,
        l.triple_id, l.source_span_json, l.evidence_strength, l.created_at as link_created_at,
        l.metadata_json as link_metadata_json,
        s.*
      FROM project_knowledge_kg_links l
      JOIN project_knowledge_sources s ON s.id = l.source_id
      WHERE l.project_key = ? AND l.triple_id = ?
      ORDER BY s.source_uri ASC
    `).all(projectKey, targetId) as (ProjectKnowledgeSourceRow & {
      link_id: string;
      link_project_key: string;
      link_source_id: string;
      triple_id: string;
      source_span_json: string;
      evidence_strength: number;
      link_created_at: number;
      link_metadata_json: string;
    })[];

    return rows.map((row) => ({
      source: rowToSource(row),
      link: {
        id: row.link_id,
        projectKey: row.link_project_key,
        sourceId: row.link_source_id,
        targetKind: 'kg_triple',
        targetId: row.triple_id,
        sourceSpan: parseSourceSpan(row.source_span_json),
        evidenceStrength: row.evidence_strength,
        createdAt: row.link_created_at,
        metadata: parseRecord(row.link_metadata_json),
      },
    }));
  }

  if (targetKind === 'code_symbol') {
    const rows = db.prepare(`
      SELECT
        c.*,
        s.id as source_row_id,
        s.project_key as source_project_key,
        s.source_kind,
        s.source_uri,
        s.source_title,
        s.content_fingerprint,
        s.created_at as source_created_at,
        s.updated_at as source_updated_at,
        s.last_seen_at,
        s.metadata_json as source_metadata_json
      FROM project_code_symbols c
      JOIN project_knowledge_sources s ON s.id = c.source_id
      WHERE c.project_key = ? AND c.symbol_id = ?
      ORDER BY c.path_from_root ASC, c.start_line ASC, c.name ASC
    `).all(projectKey, targetId) as (ProjectCodeSymbolRow & {
      source_row_id: string;
      source_project_key: string;
      source_kind: string;
      source_uri: string;
      source_title: string | null;
      content_fingerprint: string;
      source_created_at: number;
      source_updated_at: number;
      last_seen_at: number;
      source_metadata_json: string;
    })[];

    return rows.map((row) => {
      const startLine = row.start_line;
      const startColumn = row.start_character;
      const metadata = parseRecord(row.metadata_json);

      return {
        source: rowToSource({
          id: row.source_row_id,
          project_key: row.source_project_key,
          source_kind: row.source_kind,
          source_uri: row.source_uri,
          source_title: row.source_title,
          content_fingerprint: row.content_fingerprint,
          created_at: row.source_created_at,
          updated_at: row.source_updated_at,
          last_seen_at: row.last_seen_at,
          metadata_json: row.source_metadata_json,
        }),
        link: {
          id: projectCodeSymbolEvidenceId(projectKey, row.symbol_id, row.source_id),
          projectKey,
          sourceId: row.source_id,
          targetKind: 'code_symbol' as const,
          targetId: row.symbol_id,
          sourceSpan: {
            kind: 'file_lines' as const,
            path: row.source_uri,
            startLine,
            endLine: row.end_line ?? startLine,
            startColumn,
            endColumn: row.end_character ?? startColumn,
          },
          evidenceStrength: 1,
          createdAt: row.created_at,
          metadata: {
            workspaceHash: row.workspace_hash,
            symbolKind: row.kind,
            containerName: row.container_name ?? undefined,
            evidenceKind: 'definition_location',
            snapshotVersion: metadata['snapshotVersion'],
          },
        },
      };
    });
  }

  const rows = db.prepare(`
    SELECT
      l.id as link_id, l.project_key as link_project_key, l.source_id as link_source_id,
      l.hint_id, l.source_span_json, l.evidence_strength, l.created_at as link_created_at,
      l.metadata_json as link_metadata_json,
      s.*
    FROM project_knowledge_wake_links l
    JOIN project_knowledge_sources s ON s.id = l.source_id
    WHERE l.project_key = ? AND l.hint_id = ?
    ORDER BY s.source_uri ASC
  `).all(projectKey, targetId) as (ProjectKnowledgeSourceRow & {
    link_id: string;
    link_project_key: string;
    link_source_id: string;
    hint_id: string;
    source_span_json: string;
    evidence_strength: number;
    link_created_at: number;
    link_metadata_json: string;
  })[];

  return rows.map((row) => ({
    source: rowToSource(row),
    link: {
      id: row.link_id,
      projectKey: row.link_project_key,
      sourceId: row.link_source_id,
      targetKind: 'wake_hint',
      targetId: row.hint_id,
      sourceSpan: parseSourceSpan(row.source_span_json),
      evidenceStrength: row.evidence_strength,
      createdAt: row.link_created_at,
      metadata: parseRecord(row.link_metadata_json),
    },
  }));
}

export function getProjectKnowledgeSourceInventory(
  db: SqliteDriver,
  projectKey: string,
): ProjectKnowledgeSourceInventory {
  const sourceRows = db.prepare(`
    SELECT source_kind, COUNT(*) as count
    FROM project_knowledge_sources
    WHERE project_key = ?
    GROUP BY source_kind
  `).all(projectKey) as { source_kind: ProjectKnowledgeSourceKind; count: number }[];
  const totalSources = sourceRows.reduce((sum, row) => sum + row.count, 0);
  const byKind: Partial<Record<ProjectKnowledgeSourceKind, number>> = {};

  for (const row of sourceRows) {
    byKind[row.source_kind] = row.count;
  }

  const totalKgLinks = (db.prepare(`
    SELECT COUNT(*) as count FROM project_knowledge_kg_links WHERE project_key = ?
  `).get(projectKey) as { count: number }).count;
  const totalWakeLinks = (db.prepare(`
    SELECT COUNT(*) as count FROM project_knowledge_wake_links WHERE project_key = ?
  `).get(projectKey) as { count: number }).count;
  const totalCodeSymbols = (db.prepare(`
    SELECT COUNT(*) as count FROM project_code_symbols WHERE project_key = ?
  `).get(projectKey) as { count: number }).count;

  return {
    totalSources,
    totalLinks: totalKgLinks + totalWakeLinks,
    totalKgLinks,
    totalWakeLinks,
    totalCodeSymbols,
    byKind,
  };
}

function mustGetSource(db: SqliteDriver, id: string): ProjectKnowledgeSourceRow {
  const row = db.prepare('SELECT * FROM project_knowledge_sources WHERE id = ?').get(id) as ProjectKnowledgeSourceRow | undefined;
  if (!row) {
    throw new Error(`Project knowledge source not found: ${id}`);
  }
  return row;
}

function assertSourceBelongsToProject(db: SqliteDriver, sourceId: string, projectKey: string): void {
  const row = db.prepare('SELECT project_key FROM project_knowledge_sources WHERE id = ?').get(sourceId) as { project_key: string } | undefined;
  if (!row) {
    throw new Error(`Project knowledge source not found: ${sourceId}`);
  }
  if (row.project_key !== projectKey) {
    throw new Error(`Project knowledge source ${sourceId} does not belong to project ${projectKey}`);
  }
}

function rowToSource(row: ProjectKnowledgeSourceRow): ProjectKnowledgeSource {
  return {
    id: row.id,
    projectKey: row.project_key,
    sourceKind: parseSourceKind(row.source_kind),
    sourceUri: row.source_uri,
    sourceTitle: row.source_title ?? undefined,
    contentFingerprint: row.content_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
    metadata: parseRecord(row.metadata_json),
  };
}

function kgLinkRowToLink(row: ProjectKnowledgeKgLinkRow): ProjectKnowledgeSourceLink {
  return {
    id: row.id,
    projectKey: row.project_key,
    sourceId: row.source_id,
    targetKind: 'kg_triple',
    targetId: row.triple_id,
    sourceSpan: parseSourceSpan(row.source_span_json),
    evidenceStrength: row.evidence_strength,
    createdAt: row.created_at,
    metadata: parseRecord(row.metadata_json),
  };
}

function wakeLinkRowToLink(row: ProjectKnowledgeWakeLinkRow): ProjectKnowledgeSourceLink {
  return {
    id: row.id,
    projectKey: row.project_key,
    sourceId: row.source_id,
    targetKind: 'wake_hint',
    targetId: row.hint_id,
    sourceSpan: parseSourceSpan(row.source_span_json),
    evidenceStrength: row.evidence_strength,
    createdAt: row.created_at,
    metadata: parseRecord(row.metadata_json),
  };
}

function stableId(prefix: string, ...parts: string[]): string {
  const hash = crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24);
  return `${prefix}_${hash}`;
}

function parseSourceKind(value: string): ProjectKnowledgeSourceKind {
  if (
    value === 'manifest'
    || value === 'readme'
    || value === 'instruction_doc'
    || value === 'config'
    || value === 'code_file'
  ) {
    return value;
  }
  return 'config';
}

function parseSourceSpan(value: string): ProjectSourceSpan {
  try {
    const parsed = JSON.parse(value) as Partial<ProjectSourceSpan>;
    if (parsed.kind === 'whole_source') {
      return { kind: 'whole_source' };
    }
    if (
      parsed.kind === 'file_lines'
      && typeof parsed.path === 'string'
      && typeof parsed.startLine === 'number'
      && typeof parsed.endLine === 'number'
    ) {
      return {
        kind: 'file_lines',
        path: parsed.path,
        startLine: parsed.startLine,
        endLine: parsed.endLine,
        startColumn: typeof parsed.startColumn === 'number' ? parsed.startColumn : undefined,
        endColumn: typeof parsed.endColumn === 'number' ? parsed.endColumn : undefined,
      };
    }
  } catch {
    // Corrupt evidence metadata should not break Knowledge UI reads.
  }
  return DEFAULT_SOURCE_SPAN;
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Corrupt metadata should be ignored.
  }
  return {};
}
