// src/main/persistence/rlm/rlm-knowledge-graph.ts
import type { SqliteDriver } from '../../db/sqlite-driver';
import * as crypto from 'crypto';
import type { KGEntityRow, KGTripleRow } from '../rlm-database.types';
import type { KGQueryResult, KGStats, KGDirection } from '../../../shared/types/knowledge-graph.types';

export function normalizeEntityId(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '_').replace(/'/g, '');
}

function normalizePredicate(predicate: string): string {
  return predicate.toLowerCase().replace(/\s+/g, '_');
}

function generateTripleId(subjectId: string, predicate: string, objectId: string, validFrom: string | null): string {
  const hashInput = `${validFrom || ''}${Date.now()}`;
  const hash = crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 12);
  return `t_${subjectId}_${predicate}_${objectId}_${hash}`;
}

export function upsertEntity(db: SqliteDriver, name: string, type = 'unknown', properties: Record<string, unknown> = {}): string {
  const id = normalizeEntityId(name);
  db.prepare(`
    INSERT INTO kg_entities (id, name, type, properties_json, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      properties_json = excluded.properties_json
  `).run(id, name, type, JSON.stringify(properties), Date.now());
  return id;
}

export function getEntity(db: SqliteDriver, id: string): KGEntityRow | undefined {
  return db.prepare('SELECT * FROM kg_entities WHERE id = ?').get(id) as KGEntityRow | undefined;
}

export function listEntities(db: SqliteDriver, type?: string): KGEntityRow[] {
  if (type) {
    return db.prepare('SELECT * FROM kg_entities WHERE type = ? ORDER BY name').all(type) as KGEntityRow[];
  }
  return db.prepare('SELECT * FROM kg_entities ORDER BY name').all() as KGEntityRow[];
}

export interface AddTripleParams {
  subject: string;
  predicate: string;
  object: string;
  validFrom?: string | null;
  validTo?: string | null;
  confidence?: number;
  sourceCloset?: string | null;
  sourceFile?: string | null;
}

export function addTriple(db: SqliteDriver, params: AddTripleParams): string {
  const subjectId = normalizeEntityId(params.subject);
  const objectId = normalizeEntityId(params.object);
  const predicate = normalizePredicate(params.predicate);

  upsertEntity(db, params.subject);
  upsertEntity(db, params.object);

  const existing = db.prepare(`
    SELECT id FROM kg_triples
    WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL
  `).get(subjectId, predicate, objectId) as { id: string } | undefined;

  if (existing) {
    return existing.id;
  }

  const id = generateTripleId(subjectId, predicate, objectId, params.validFrom ?? null);

  db.prepare(`
    INSERT INTO kg_triples (id, subject, predicate, object, valid_from, valid_to, confidence, source_closet, source_file, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, subjectId, predicate, objectId, params.validFrom ?? null, params.validTo ?? null, params.confidence ?? 1.0, params.sourceCloset ?? null, params.sourceFile ?? null, Date.now());

  return id;
}

export function invalidateTriple(db: SqliteDriver, subject: string, predicate: string, object: string, ended?: string): number {
  const subjectId = normalizeEntityId(subject);
  const objectId = normalizeEntityId(object);
  const pred = normalizePredicate(predicate);
  const endDate = ended ?? new Date().toISOString().slice(0, 10);

  return db.prepare(`
    UPDATE kg_triples SET valid_to = ?
    WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL
  `).run(endDate, subjectId, pred, objectId).changes;
}

interface QueryEntityOptions {
  direction?: KGDirection;
  asOf?: string;
}

export function queryEntity(db: SqliteDriver, name: string, options: QueryEntityOptions = {}): KGQueryResult[] {
  const entityId = normalizeEntityId(name);
  const direction = options.direction ?? 'both';
  const results: KGQueryResult[] = [];

  const temporalClause = options.asOf
    ? 'AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)'
    : '';
  const temporalParams = options.asOf ? [options.asOf, options.asOf] : [];

  if (direction === 'outgoing' || direction === 'both') {
    const rows = db.prepare(`
      SELECT t.*, s.name as subject_name, o.name as object_name
      FROM kg_triples t
      JOIN kg_entities s ON s.id = t.subject
      JOIN kg_entities o ON o.id = t.object
      WHERE t.subject = ? ${temporalClause}
    `).all(entityId, ...temporalParams) as (KGTripleRow & { subject_name: string; object_name: string })[];

    for (const row of rows) {
      results.push({
        direction: 'outgoing',
        subject: row.subject_name,
        predicate: row.predicate,
        object: row.object_name,
        validFrom: row.valid_from,
        validTo: row.valid_to,
        confidence: row.confidence,
        sourceCloset: row.source_closet,
        current: row.valid_to === null,
      });
    }
  }

  if (direction === 'incoming' || direction === 'both') {
    const rows = db.prepare(`
      SELECT t.*, s.name as subject_name, o.name as object_name
      FROM kg_triples t
      JOIN kg_entities s ON s.id = t.subject
      JOIN kg_entities o ON o.id = t.object
      WHERE t.object = ? ${temporalClause}
    `).all(entityId, ...temporalParams) as (KGTripleRow & { subject_name: string; object_name: string })[];

    for (const row of rows) {
      results.push({
        direction: 'incoming',
        subject: row.subject_name,
        predicate: row.predicate,
        object: row.object_name,
        validFrom: row.valid_from,
        validTo: row.valid_to,
        confidence: row.confidence,
        sourceCloset: row.source_closet,
        current: row.valid_to === null,
      });
    }
  }

  return results;
}

export function queryRelationship(db: SqliteDriver, predicate: string, asOf?: string): KGQueryResult[] {
  const pred = normalizePredicate(predicate);
  const temporalClause = asOf
    ? 'AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)'
    : '';
  const temporalParams = asOf ? [asOf, asOf] : [];

  const rows = db.prepare(`
    SELECT t.*, s.name as subject_name, o.name as object_name
    FROM kg_triples t
    JOIN kg_entities s ON s.id = t.subject
    JOIN kg_entities o ON o.id = t.object
    WHERE t.predicate = ? ${temporalClause}
  `).all(pred, ...temporalParams) as (KGTripleRow & { subject_name: string; object_name: string })[];

  return rows.map(row => ({
    direction: 'outgoing' as KGDirection,
    subject: row.subject_name,
    predicate: row.predicate,
    object: row.object_name,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    confidence: row.confidence,
    sourceCloset: row.source_closet,
    current: row.valid_to === null,
  }));
}

export function timeline(db: SqliteDriver, entityName?: string, limit = 100): KGQueryResult[] {
  const baseQuery = `
    SELECT t.*, s.name as subject_name, o.name as object_name
    FROM kg_triples t
    JOIN kg_entities s ON s.id = t.subject
    JOIN kg_entities o ON o.id = t.object
  `;

  let rows: (KGTripleRow & { subject_name: string; object_name: string })[];

  if (entityName) {
    const entityId = normalizeEntityId(entityName);
    rows = db.prepare(`
      ${baseQuery}
      WHERE t.subject = ? OR t.object = ?
      ORDER BY CASE WHEN t.valid_from IS NULL THEN 1 ELSE 0 END, t.valid_from ASC
      LIMIT ?
    `).all(entityId, entityId, limit) as typeof rows;
  } else {
    rows = db.prepare(`
      ${baseQuery}
      ORDER BY CASE WHEN t.valid_from IS NULL THEN 1 ELSE 0 END, t.valid_from ASC
      LIMIT ?
    `).all(limit) as typeof rows;
  }

  return rows.map(row => ({
    direction: 'outgoing' as KGDirection,
    subject: row.subject_name,
    predicate: row.predicate,
    object: row.object_name,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    confidence: row.confidence,
    sourceCloset: row.source_closet,
    current: row.valid_to === null,
  }));
}

export function getStats(db: SqliteDriver): KGStats {
  const entities = (db.prepare('SELECT COUNT(*) as count FROM kg_entities').get() as { count: number }).count;
  const triples = (db.prepare('SELECT COUNT(*) as count FROM kg_triples').get() as { count: number }).count;
  const currentFacts = (db.prepare('SELECT COUNT(*) as count FROM kg_triples WHERE valid_to IS NULL').get() as { count: number }).count;
  const expiredFacts = (db.prepare('SELECT COUNT(*) as count FROM kg_triples WHERE valid_to IS NOT NULL').get() as { count: number }).count;
  const relationshipTypes = (db.prepare('SELECT DISTINCT predicate FROM kg_triples ORDER BY predicate').all() as { predicate: string }[])
    .map(r => r.predicate);

  return { entities, triples, currentFacts, expiredFacts, relationshipTypes };
}
