import * as crypto from 'crypto';
import type { SqliteDriver } from '../../db/sqlite-driver';
import type { ProjectMemoryStartupBriefRow } from '../rlm-database.types';
import type { ProjectMemoryBriefSection, ProjectMemoryBriefSource } from '../../memory/project-memory-brief';

export interface RecordProjectMemoryStartupBriefParams {
  instanceId: string;
  projectKey: string;
  renderedText: string;
  sections: ProjectMemoryBriefSection[];
  sources: ProjectMemoryBriefSource[];
  maxChars: number;
  truncated: boolean;
  provider?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface ProjectMemoryStartupBriefRecord extends ProjectMemoryStartupBriefRow {
  sections: ProjectMemoryBriefSection[];
  sources: ProjectMemoryBriefSource[];
  metadata: Record<string, unknown>;
}

export function projectMemoryStartupBriefId(instanceId: string): string {
  return stableId('pmsb', instanceId);
}

export function recordProjectMemoryStartupBrief(db: SqliteDriver, params: RecordProjectMemoryStartupBriefParams): ProjectMemoryStartupBriefRecord {
  const id = projectMemoryStartupBriefId(params.instanceId);
  const now = Date.now();

  const renderedChars = params.renderedText.length;
  const sourceCount = params.sources.length;

  const sectionsJson = JSON.stringify(params.sections);
  const sourcesJson = JSON.stringify(params.sources);
  const metadataJson = JSON.stringify(params.metadata ?? {});

  db.prepare(`
    INSERT INTO project_memory_startup_briefs (
      id, instance_id, project_key, rendered_text, sections_json, sources_json,
      max_chars, rendered_chars, source_count, truncated, provider, model, created_at, metadata_json
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    ) ON CONFLICT(instance_id) DO UPDATE SET
      project_key = EXCLUDED.project_key,
      rendered_text = EXCLUDED.rendered_text,
      sections_json = EXCLUDED.sections_json,
      sources_json = EXCLUDED.sources_json,
      max_chars = EXCLUDED.max_chars,
      rendered_chars = EXCLUDED.rendered_chars,
      source_count = EXCLUDED.source_count,
      truncated = EXCLUDED.truncated,
      provider = EXCLUDED.provider,
      model = EXCLUDED.model,
      created_at = EXCLUDED.created_at,
      metadata_json = EXCLUDED.metadata_json
    WHERE id = EXCLUDED.id
  `).run(
    id,
    params.instanceId,
    params.projectKey,
    params.renderedText,
    sectionsJson,
    sourcesJson,
    params.maxChars,
    renderedChars,
    sourceCount,
    params.truncated ? 1 : 0,
    params.provider ?? null,
    params.model ?? null,
    now,
    metadataJson,
  );

  return getProjectMemoryStartupBriefByInstance(db, params.instanceId)!;
}

export function getProjectMemoryStartupBriefByInstance(db: SqliteDriver, instanceId: string): ProjectMemoryStartupBriefRecord | undefined {
  const id = projectMemoryStartupBriefId(instanceId);
  const row = db.prepare(`SELECT * FROM project_memory_startup_briefs WHERE id = ?`).get(id) as ProjectMemoryStartupBriefRow | undefined;

  if (!row) {
    return undefined;
  }

  return projectMemoryStartupBriefRowToRecord(row);
}

function projectMemoryStartupBriefRowToRecord(row: ProjectMemoryStartupBriefRow): ProjectMemoryStartupBriefRecord {
  return {
    ...row,
    sections: safelyParseJson<ProjectMemoryBriefSection[]>(row.sections_json, []),
    sources: safelyParseJson<ProjectMemoryBriefSource[]>(row.sources_json, []),
    metadata: safelyParseJson<Record<string, unknown>>(row.metadata_json, {}),
  };
}

function safelyParseJson<T>(json: string, defaultValue: T): T {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(defaultValue)) {
      return Array.isArray(parsed) ? parsed as T : defaultValue;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as T;
    }
  } catch {
    // Corrupt startup-brief metadata should not break inspection.
  }
  return defaultValue;
}

function stableId(prefix: string, ...parts: string[]): string {
  const hash = crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24);
  return `${prefix}_${hash}`;
}
