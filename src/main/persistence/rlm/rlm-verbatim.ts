// src/main/persistence/rlm/rlm-verbatim.ts
import type Database from 'better-sqlite3';
import * as crypto from 'crypto';
import type { VerbatimSegmentRow, ConversationImportRow } from '../rlm-database.types';

export interface AddSegmentParams {
  id?: string;
  content: string;
  sourceFile: string;
  chunkIndex: number;
  wing: string;
  room: string;
  importance?: number;
  addedBy?: string;
}

function generateSegmentId(sourceFile: string, chunkIndex: number): string {
  const hash = crypto.createHash('sha256')
    .update(`${sourceFile}${chunkIndex}`)
    .digest('hex')
    .slice(0, 24);
  return `vseg_${hash}`;
}

export function addSegment(db: Database.Database, params: AddSegmentParams): string {
  const id = params.id ?? generateSegmentId(params.sourceFile, params.chunkIndex);

  db.prepare(`
    INSERT INTO verbatim_segments (id, content, source_file, chunk_index, wing, room, importance, added_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      wing = excluded.wing,
      room = excluded.room,
      importance = excluded.importance
  `).run(id, params.content, params.sourceFile, params.chunkIndex, params.wing, params.room, params.importance ?? 3.0, params.addedBy ?? 'system', Date.now());

  return id;
}

export function getSegment(db: Database.Database, id: string): VerbatimSegmentRow | undefined {
  return db.prepare('SELECT * FROM verbatim_segments WHERE id = ?').get(id) as VerbatimSegmentRow | undefined;
}

export function queryByWingRoom(db: Database.Database, filter: { wing?: string; room?: string; limit?: number }): VerbatimSegmentRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.wing) {
    conditions.push('wing = ?');
    params.push(filter.wing);
  }
  if (filter.room) {
    conditions.push('room = ?');
    params.push(filter.room);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(filter.limit ?? 100);

  return db.prepare(`
    SELECT * FROM verbatim_segments ${where}
    ORDER BY importance DESC, created_at DESC
    LIMIT ?
  `).all(...params) as VerbatimSegmentRow[];
}

export function getTopByImportance(db: Database.Database, limit: number, wing?: string): VerbatimSegmentRow[] {
  if (wing) {
    return db.prepare('SELECT * FROM verbatim_segments WHERE wing = ? ORDER BY importance DESC LIMIT ?').all(wing, limit) as VerbatimSegmentRow[];
  }
  return db.prepare('SELECT * FROM verbatim_segments ORDER BY importance DESC LIMIT ?').all(limit) as VerbatimSegmentRow[];
}

export function deleteBySource(db: Database.Database, sourceFile: string): number {
  return db.prepare('DELETE FROM verbatim_segments WHERE source_file = ?').run(sourceFile).changes;
}

export function getSegmentCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) as count FROM verbatim_segments').get() as { count: number }).count;
}

export interface RecordImportParams {
  filePath: string;
  format: string;
  wing: string;
  messageCount: number;
}

export function recordImport(db: Database.Database, params: RecordImportParams): string {
  const id = `imp_${crypto.randomUUID().slice(0, 12)}`;
  db.prepare(`
    INSERT INTO conversation_imports (id, file_path, format, wing, message_count, status, imported_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, params.filePath, params.format, params.wing, params.messageCount, Date.now());
  return id;
}

export function updateImportStatus(db: Database.Database, id: string, status: 'imported' | 'failed', segmentsCreated?: number, error?: string): void {
  db.prepare(`
    UPDATE conversation_imports
    SET status = ?, segments_created = COALESCE(?, segments_created), error = ?
    WHERE id = ?
  `).run(status, segmentsCreated ?? null, error ?? null, id);
}

export function getImport(db: Database.Database, id: string): ConversationImportRow | undefined {
  return db.prepare('SELECT * FROM conversation_imports WHERE id = ?').get(id) as ConversationImportRow | undefined;
}

export function isFileImported(db: Database.Database, filePath: string): boolean {
  const row = db.prepare("SELECT id FROM conversation_imports WHERE file_path = ? AND status = 'imported' LIMIT 1").get(filePath);
  return row !== undefined;
}
